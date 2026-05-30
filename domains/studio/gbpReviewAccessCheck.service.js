// Manual "Check review API access" probe.
//
// Workspace owner clicks a button → we hit reviews.list with
// pageSize=1 against the connection's selected location. The
// only outcomes that matter:
//   - 200 OK: Google has approved review access. Clear any
//     stale REVIEW_API_ACCESS_DENIED marker on the connection
//     so the resolver flips REPLY_REVIEW back to available and
//     the next poller tick fetches real data.
//   - 403 / "API has not been used" / AUTH_PERMISSION_DENIED:
//     access still pending. Persist the marker so the Settings
//     tile keeps showing the access-pending banner, and reply
//     send refuses pre-flight.
//   - Any other 4xx/5xx: surface the raw provider message so
//     ops can diagnose. Don't touch the marker — could be a
//     transient blip.
//
// Reuses the poller's token-refresh logic transparently: if the
// access token is near expiry we refresh + persist the new
// token before the probe call.

import { prisma } from "../../prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import {
  listReviews,
  refreshAccessToken,
} from "./oauth/googleBusinessProfile.oauth.js";
import {
  isReviewApiAccessDenied,
  buildAccessDeniedMarker,
} from "../inbox/gbpReviewAccessMarker.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

class GbpAccessCheckError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "GbpAccessCheckError";
    this.status = status ?? 500;
    this.code = code ?? "GBP_ACCESS_CHECK_FAILED";
  }
}

/**
 * Run a one-shot reviews.list probe against the workspace's
 * selected GBP location.
 *
 * @returns {Promise<{ status: 'ok' | 'access_denied' | 'no_location' | 'error',
 *                     message: string,
 *                     providerMessage?: string }>}
 *
 * Never throws on logical failures (access denied, missing
 * location). Throws only on system-level errors (DB down,
 * connection not found in this workspace).
 */
export async function checkGbpReviewAccess({ clientId }) {
  const conn = await prisma.channelConnection.findUnique({
    where: {
      clientId_channel: { clientId, channel: "GOOGLE_BUSINESS_PROFILE" },
    },
  });
  if (!conn) {
    throw new GbpAccessCheckError(
      "No Google Business Profile connection on this workspace.",
      { status: 404, code: "NO_CONNECTION" },
    );
  }
  if (conn.status !== "CONNECTED") {
    throw new GbpAccessCheckError(
      "Google Business Profile connection is not active. Reconnect first.",
      { status: 412, code: "CONNECTION_NOT_ACTIVE" },
    );
  }
  if (
    typeof conn.externalAccountId !== "string" ||
    !conn.externalAccountId.includes("/locations/")
  ) {
    return {
      status: "no_location",
      message:
        "Pick a Google Business Profile location before running the access check.",
    };
  }

  // Refresh the token if it's near or past expiry — same logic
  // the poller uses. We avoid sharing the helper across files
  // because they each have slightly different error-handling
  // needs (the poller writes connection state on refresh failure;
  // we treat it as a probe-time error to surface to the caller).
  let accessToken;
  try {
    accessToken = await ensureFreshToken(conn);
  } catch (err) {
    return {
      status: "error",
      message:
        "Couldn't refresh the Google Business Profile access token. Reconnect Google Business Profile and try again.",
      providerMessage: err?.message,
    };
  }

  try {
    await listReviews({
      accessToken,
      locationName: conn.externalAccountId,
      pageSize: 1,
    });
    // Success — clear any prior marker so resolver/UI flip back.
    if (conn.lastError) {
      await prisma.channelConnection
        .update({ where: { id: conn.id }, data: { lastError: null } })
        .catch(() => {});
    }
    return {
      status: "ok",
      message:
        "Google approved review access. Reviews will start syncing on the next poll (within 10 minutes).",
    };
  } catch (err) {
    if (isReviewApiAccessDenied(err)) {
      const marker = buildAccessDeniedMarker(err?.message);
      if (conn.lastError !== marker) {
        await prisma.channelConnection
          .update({ where: { id: conn.id }, data: { lastError: marker } })
          .catch(() => {});
      }
      return {
        status: "access_denied",
        message:
          "Google has not approved this project for the Business Profile reviews API yet.",
        providerMessage: err?.message,
      };
    }
    // Anything else — return as-is so ops can read the actual
    // provider error without changing connection state.
    return {
      status: "error",
      message:
        err?.message ?? "Couldn't reach the Google Business Profile reviews API.",
      providerMessage: err?.message,
    };
  }
}

async function ensureFreshToken(connection) {
  const accessToken = decryptToken(connection.accessToken);
  const expiresAt = connection.tokenExpiresAt
    ? new Date(connection.tokenExpiresAt).getTime()
    : 0;
  if (expiresAt && expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return accessToken;
  }
  if (!connection.refreshToken) {
    const err = new Error("No refresh token; user must reconnect Google Business Profile.");
    err.code = "AUTH_FAILED";
    throw err;
  }
  const plainRefresh = decryptToken(connection.refreshToken);
  const refreshed = await refreshAccessToken({ refreshToken: plainRefresh });
  await prisma.channelConnection
    .update({
      where: { id: connection.id },
      data: {
        accessToken: encryptToken(refreshed.accessToken),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        lastRefreshAt: new Date(),
      },
    })
    .catch(() => {});
  return refreshed.accessToken;
}
