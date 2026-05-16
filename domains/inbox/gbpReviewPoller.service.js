// Google Business Profile review-polling service.
//
// GBP has no webhook for reviews — Google requires polling. This
// service is called from the BullMQ worker on a fixed interval
// (every 10 minutes). For each CONNECTED GBP connection that has
// completed location selection, it:
//   1. Refreshes the access token if it's near/past expiry.
//   2. Calls reviews.list on the v4 API (newest first, page size 50).
//   3. Normalizes each review into the shape ingestGbpReview()
//      expects (matches the Conversation/Message contract).
//   4. Calls ingestGbpReview() — idempotent on review.name, so
//      re-fetching the same page on every tick is safe.
//
// Connections are skipped if:
//   - externalAccountId doesn't contain "/locations/" (user hasn't
//     finished the location picker yet — half-finished connection)
//   - status !== "CONNECTED"
//   - accessToken decrypt fails
//   - token refresh fails (the connection's status will already be
//     flipped by the refresh service)

import { prisma } from "../../prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import { ingestGbpReview } from "./inbox.gbp.ingestion.service.js";
import {
  listReviews,
  refreshAccessToken,
} from "../studio/oauth/googleBusinessProfile.oauth.js";
import {
  isReviewApiAccessDenied,
  buildAccessDeniedMarker,
} from "./gbpReviewAccessMarker.js";

const REVIEWS_PAGE_SIZE = 50;
// How close to expiry before we proactively refresh. Google tokens
// are 1 hour by default; 5 minutes is plenty of headroom.
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Pick the candidate connection set for the current tick.
 * Skips connections whose location picker hasn't run yet (sentinel
 * externalAccountId without "/locations/").
 */
export async function listPollableConnections({ limit = 50 } = {}) {
  const rows = await prisma.channelConnection.findMany({
    where: {
      channel: "GOOGLE_BUSINESS_PROFILE",
      status: "CONNECTED",
      externalAccountId: { contains: "/locations/" },
    },
    orderBy: { lastValidatedAt: "asc" },
    take: limit,
  });
  return rows;
}

/**
 * Refresh the access token for a connection if it's near expiry.
 * Returns the (possibly newly-refreshed) plaintext access token.
 * On refresh failure, flips connection.status to NEEDS_RECONNECT
 * and throws so the caller skips the tick for this connection.
 */
async function ensureFreshToken(connection) {
  let accessToken = decryptToken(connection.accessToken);
  const expiresAt = connection.tokenExpiresAt
    ? new Date(connection.tokenExpiresAt).getTime()
    : 0;
  if (expiresAt && expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return accessToken;
  }
  if (!connection.refreshToken) {
    await markNeedsReconnect(connection.id, "missing_refresh_token");
    const err = new Error("No refresh token; user must reconnect");
    err.code = "AUTH_FAILED";
    throw err;
  }
  const plainRefresh = decryptToken(connection.refreshToken);
  let refreshed;
  try {
    refreshed = await refreshAccessToken({ refreshToken: plainRefresh });
  } catch (err) {
    await markNeedsReconnect(connection.id, err?.message ?? "refresh_failed");
    err.code = "AUTH_FAILED";
    throw err;
  }
  const newAccess = refreshed.accessToken;
  const newExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
  await prisma.channelConnection
    .update({
      where: { id: connection.id },
      data: {
        accessToken: encryptToken(newAccess),
        tokenExpiresAt: newExpiresAt,
        lastRefreshAt: new Date(),
        lastError: null,
      },
    })
    .catch(() => {});
  return newAccess;
}

async function markNeedsReconnect(connectionId, reason) {
  try {
    await prisma.channelConnection.update({
      where: { id: connectionId },
      data: {
        status: "NEEDS_RECONNECT",
        refreshFailedAt: new Date(),
        lastError: reason,
      },
    });
  } catch {
    // best-effort — if even the status flip fails, the worker
    // will hit the same broken connection next tick and try again.
  }
}

/**
 * Poll reviews for a single connection. Returns a summary.
 */
export async function pollGbpReviewsForConnection(connection) {
  const summary = {
    connectionId: connection.id,
    clientId: connection.clientId,
    locationName: connection.externalAccountId,
    fetched: 0,
    created: 0,
    duplicate: 0,
    skipped: 0,
    error: null,
  };
  if (!connection.externalAccountId?.includes("/locations/")) {
    summary.skipped += 1;
    summary.error = "NO_LOCATION";
    return summary;
  }

  let accessToken;
  try {
    accessToken = await ensureFreshToken(connection);
  } catch (err) {
    summary.error = err?.code ?? "TOKEN_REFRESH_FAILED";
    return summary;
  }

  let reviews = [];
  try {
    reviews = await listReviews({
      accessToken,
      locationName: connection.externalAccountId,
      pageSize: REVIEWS_PAGE_SIZE,
    });
    // listReviews succeeded — clear any prior access-denied marker
    // so the UI/resolver stops surfacing the approval-pending state.
    // Only writes when there's something to clear so we don't
    // burn a write on every successful tick.
    if (connection.lastError) {
      await prisma.channelConnection
        .update({
          where: { id: connection.id },
          data: { lastError: null },
        })
        .catch(() => {});
    }
  } catch (err) {
    // Distinguish "Google hasn't allowlisted this project for the
    // legacy reviews API" (sticky, surfaced to the UI as an
    // approval-pending banner) from a transient 5xx (silently
    // retried next tick).
    if (isReviewApiAccessDenied(err)) {
      summary.error = "REVIEW_API_ACCESS_DENIED";
      const marker = buildAccessDeniedMarker(err?.message);
      // Skip the write if the marker is already exactly what we'd
      // set — saves the row update on every tick once the state
      // is settled.
      if (connection.lastError !== marker) {
        await prisma.channelConnection
          .update({
            where: { id: connection.id },
            data: { lastError: marker },
          })
          .catch(() => {});
      }
      console.warn("[gbp.poller] reviews API access denied:", {
        connectionId: connection.id,
        clientId: connection.clientId,
        locationName: connection.externalAccountId,
        providerMessage: err?.message,
      });
      return summary;
    }
    summary.error = err?.message ?? "LIST_REVIEWS_FAILED";
    return summary;
  }
  summary.fetched = reviews.length;

  for (const raw of reviews) {
    const normalized = normalizeGbpReview({
      raw,
      locationName: connection.externalAccountId,
    });
    if (!normalized) {
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await ingestGbpReview(normalized);
      if (result.status === "created") summary.created += 1;
      else if (result.status === "duplicate") summary.duplicate += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.skipped += 1;
      console.error("[gbp.poller] ingestGbpReview failed:", {
        connectionId: connection.id,
        reviewName: raw?.name,
        err: err?.message,
      });
    }
  }

  await prisma.channelConnection
    .update({
      where: { id: connection.id },
      data: { lastValidatedAt: new Date() },
    })
    .catch(() => {});

  return summary;
}

/**
 * Map a raw Google Reviews API v4 payload to the normalized shape
 * ingestGbpReview() expects. Returns null when the payload is too
 * malformed to be useful.
 *
 * v4 review shape (relevant fields):
 *   {
 *     name: "accounts/{a}/locations/{l}/reviews/{r}",
 *     reviewId: "{r}",
 *     reviewer: { displayName?, profilePhotoUrl?, isAnonymous? },
 *     starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE",
 *     comment: string?,
 *     createTime: ISO8601,
 *     updateTime: ISO8601,
 *     reviewReply: { comment, updateTime }?
 *   }
 */
export function normalizeGbpReview({ raw, locationName }) {
  if (!raw || typeof raw !== "object") return null;
  const reviewName = typeof raw.name === "string" ? raw.name : null;
  if (!reviewName) return null;
  // Convert the star rating enum to a number for the body renderer.
  const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  const starRating =
    typeof raw.starRating === "string" && raw.starRating in STAR_MAP
      ? STAR_MAP[raw.starRating]
      : null;
  const reviewerObj = raw.reviewer && typeof raw.reviewer === "object" ? raw.reviewer : {};
  // Google doesn't expose a stable profile id, but the displayName
  // alone is a serviceable identifier when paired with isAnonymous.
  // For named reviewers we use a hash-like compound of name +
  // (truncated photo URL) so two anonymous reviewers don't collide.
  const isAnonymous = Boolean(reviewerObj.isAnonymous);
  const googleId = isAnonymous
    ? `anon:${reviewerObj.displayName ?? "Google reviewer"}`
    : (reviewerObj.profilePhotoUrl ?? reviewerObj.displayName ?? null);
  return {
    locationName,
    reviewId: reviewName,
    starRating,
    comment: typeof raw.comment === "string" ? raw.comment : null,
    reviewer: {
      googleId: googleId ? String(googleId).slice(0, 240) : null,
      displayName:
        typeof reviewerObj.displayName === "string"
          ? reviewerObj.displayName
          : null,
      isAnonymous,
    },
    createTime: typeof raw.createTime === "string" ? raw.createTime : null,
    updateTime: typeof raw.updateTime === "string" ? raw.updateTime : null,
    reviewReply: raw.reviewReply && typeof raw.reviewReply === "object"
      ? {
          comment:
            typeof raw.reviewReply.comment === "string"
              ? raw.reviewReply.comment
              : null,
          updateTime:
            typeof raw.reviewReply.updateTime === "string"
              ? raw.reviewReply.updateTime
              : null,
        }
      : null,
    sourceUrl: null, // GBP doesn't return a permalink in the v4 payload
  };
}

/**
 * Run a single polling tick across all candidate connections.
 * Called by the worker on the cron schedule + by the manual
 * "Sync reviews now" admin route.
 */
export async function runGbpReviewPollTick({ batchSize = 50 } = {}) {
  const start = Date.now();
  const conns = await listPollableConnections({ limit: batchSize });
  const totals = { connections: conns.length, created: 0, duplicate: 0, errors: 0, fetched: 0 };
  for (const conn of conns) {
    const summary = await pollGbpReviewsForConnection(conn);
    totals.created += summary.created;
    totals.duplicate += summary.duplicate;
    totals.fetched += summary.fetched;
    if (summary.error) totals.errors += 1;
  }
  const elapsed = Date.now() - start;
  console.log(
    `[gbp.poller] tick complete: ${totals.connections} conns, ${totals.fetched} fetched, ${totals.created} created, ${totals.duplicate} dup, ${totals.errors} err (${elapsed}ms)`,
  );
  return totals;
}
