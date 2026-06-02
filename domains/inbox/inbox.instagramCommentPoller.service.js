// Instagram media comment polling service.
//
// Prompt 01 removed the Meta webhook receiver; this service replaces
// the IG comment intake side. For each CONNECTED INSTAGRAM
// ChannelConnection (Instagram Business Login user token, NOT a
// Facebook Page token), we poll
// `graph.instagram.com/{ig-media-id}/comments` per recently-published
// IG media and idempotently ingest each comment via the shared
// persistence helper in `inbox.metaCommentIngestion.service.js`.
//
// IMPORTANT — host selection:
//   Direct IG Business Login user tokens (`IGAA...` prefix) are
//   rejected by `graph.facebook.com` with "Invalid OAuth access
//   token - Cannot parse access token" (confirmed in prod 2026-05-31
//   during the publish path post-mortem). IG Business endpoints
//   MUST route through `graph.instagram.com` (INSTAGRAM_GRAPH_BASE).
//   See `inbox.outbound.instagram.service.js` and
//   `domains/studio/publishing/channelAdapters/instagram.adapter.js`
//   for the established pattern.
//
// For each CONNECTED INSTAGRAM ChannelConnection:
//   1. Verify required scope (instagram_business_manage_comments).
//      Skip with a clear error if missing — Graph would return a
//      permission error otherwise.
//   2. Ensure the IG user access token is fresh (60-day long-lived
//      token refreshable via instagramRefresh; the shared
//      ensureValidAccessToken handles dispatch).
//   3. Enumerate the workspace's recently-published IG media
//      (Drafts with channel=INSTAGRAM and externalPostId set, within
//      a 30-day window).
//   4. For each media item, walk /{externalPostId}/comments
//      (newest-first) up to MAX_PAGES_PER_MEDIA. Each comment is
//      normalized and handed to upsertExternalCommentMessage which
//      owns the idempotency check.
//
// Echo guard: if the comment's `from.id` equals the IG user id (us
// replying to ourselves through the outbound reply path), skip with
// reason ECHO_FROM_ACCOUNT.
//
// Missing-from-id: Meta's IG comment payloads sometimes omit `from`
// entirely (depends on the commenter's settings + API version). The
// shared helper requires a fromId to dedupe contacts — skip those
// comments with reason MISSING_FROM_ID. Same shape the deleted
// webhook ingester used.
//
// Connections are skipped if:
//   - externalAccountId is missing (no IG user id stored).
//   - status !== "CONNECTED".
//   - required scope is missing.
//   - access token decrypt or refresh fails.
//   - 401/403 from Graph → mark NEEDS_RECONNECT, stop this connection.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { ensureValidAccessToken } from "../studio/tokenRefreshService.js";
import { INSTAGRAM_GRAPH_BASE } from "../studio/meta.constants.js";
import { upsertExternalCommentMessage } from "./inbox.metaCommentIngestion.service.js";

const MAX_PAGES_PER_MEDIA = 5;
const PAGE_SIZE = 100;
const MEDIA_LOOKBACK_DAYS = 30;

const REQUIRED_SCOPE = "instagram_business_manage_comments";

// IG comment fields differ from FB: text/username/timestamp instead
// of message/from.name/created_time. We still request `from` because
// some accounts surface it (and we need fromId for contact dedupe);
// when absent we skip the comment with MISSING_FROM_ID.
const FIELDS = ["id", "text", "username", "timestamp", "like_count", "from"].join(",");

function emptySummary() {
  return {
    mediaChecked: 0,
    commentsFetched: 0,
    messagesCreated: 0,
    conversationsCreated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };
}

function mergeSummaries(into, from) {
  into.mediaChecked += from.mediaChecked;
  into.commentsFetched += from.commentsFetched;
  into.messagesCreated += from.messagesCreated;
  into.conversationsCreated += from.conversationsCreated;
  into.duplicatesSkipped += from.duplicatesSkipped;
  if (Array.isArray(from.errors) && from.errors.length) {
    into.errors.push(...from.errors);
  }
}

/** Candidate connection set for the current tick. */
export async function listPollableConnections({ limit = 50 } = {}) {
  return prisma.channelConnection.findMany({
    where: {
      channel: "INSTAGRAM",
      status: "CONNECTED",
      externalAccountId: { not: null },
    },
    orderBy: { lastValidatedAt: "asc" },
    take: limit,
  });
}

/**
 * Enumerate the workspace's published IG media eligible for comment
 * polling. Draft.externalPostId is the IG media id, written by the
 * publish path on success.
 */
export async function listMediaForWorkspace({
  clientId,
  lookbackDays = MEDIA_LOOKBACK_DAYS,
  since,
  limit,
}) {
  const sinceDate =
    since instanceof Date
      ? since
      : new Date(Date.now() - lookbackDays * 24 * 60 * 60_000);
  const query = {
    where: {
      clientId,
      channel: "INSTAGRAM",
      externalPostId: { not: null },
      publishedAt: { gte: sinceDate },
    },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      externalPostId: true,
      externalPostUrl: true,
      publishedAt: true,
    },
  };
  if (typeof limit === "number" && limit > 0) {
    query.take = limit;
  }
  const drafts = await prisma.draft.findMany(query);
  return drafts.map((d) => ({
    draftId: d.id,
    mediaId: d.externalPostId,
    mediaUrl: d.externalPostUrl,
    publishedAt: d.publishedAt,
  }));
}

/**
 * Fetch one page of /{mediaId}/comments. Always hits
 * INSTAGRAM_GRAPH_BASE (graph.instagram.com) — see header.
 */
async function fetchCommentsPage({ accessToken, mediaId, after }) {
  const params = new URLSearchParams({
    fields: FIELDS,
    limit: String(PAGE_SIZE),
    access_token: accessToken,
  });
  if (after) params.set("after", after);
  const url = `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(mediaId)}/comments?${params.toString()}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      body?.error?.message ?? `Instagram /comments failed with ${res.status}`,
    );
    err.status = res.status;
    err.providerError = body?.error ?? null;
    throw err;
  }
  return body ?? {};
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
    // Connection may have been deleted mid-tick — non-fatal.
  }
}

function hasRequiredScope(scopes) {
  return Array.isArray(scopes) && scopes.includes(REQUIRED_SCOPE);
}

async function processMedia({ accessToken, media, connection, summary, dryRun }) {
  summary.mediaChecked += 1;

  let after = null;
  let pagesFetched = 0;
  while (pagesFetched < MAX_PAGES_PER_MEDIA) {
    let page;
    try {
      page = await fetchCommentsPage({
        accessToken,
        mediaId: media.mediaId,
        after,
      });
    } catch (err) {
      const status = err?.status ?? 0;
      if (status === 401 || status === 403) {
        summary.errors.push({
          context: `media:${media.mediaId}`,
          message: `AUTH_FAILED:${status} ${err?.message ?? ""}`.trim(),
        });
        return { stop: true, reason: "AUTH_FAILED" };
      }
      if (status === 404 || status === 410) {
        summary.errors.push({
          context: `media:${media.mediaId}`,
          message: `MEDIA_NOT_FOUND:${status}`,
        });
        return { stop: false };
      }
      if (status === 429 || status >= 500) {
        summary.errors.push({
          context: `media:${media.mediaId}`,
          message: `TRANSIENT:${status} ${err?.message ?? ""}`.trim(),
        });
        return { stop: false };
      }
      summary.errors.push({
        context: `media:${media.mediaId}`,
        message: `FETCH_FAILED:${status} ${err?.message ?? ""}`.trim(),
      });
      return { stop: false };
    }

    pagesFetched += 1;
    const items = Array.isArray(page?.data) ? page.data : [];
    summary.commentsFetched += items.length;

    if (!dryRun) {
      for (const c of items) {
        const fromId = c?.from?.id ?? null;
        if (!fromId) {
          // Meta sometimes omits the `from` object on IG comments;
          // the helper requires fromId for contact dedupe so we skip.
          summary.errors.push({
            context: `comment:${c?.id ?? "?"}`,
            message: "MISSING_FROM_ID",
          });
          continue;
        }
        if (String(fromId) === String(connection.externalAccountId)) {
          summary.errors.push({
            context: `comment:${c?.id ?? "?"}`,
            message: "ECHO_FROM_ACCOUNT",
          });
          continue;
        }
        // username is the public display label on IG; fall back to
        // `from.username` if the top-level field is missing.
        const username =
          typeof c?.username === "string"
            ? c.username
            : typeof c?.from?.username === "string"
              ? c.from.username
              : null;
        try {
          const result = await upsertExternalCommentMessage({
            clientId: connection.clientId,
            provider: "INSTAGRAM",
            externalAccountId: connection.externalAccountId,
            commentId: c?.id ? String(c.id) : "",
            parentPostId: media.mediaId,
            parentCommentId: null,
            body: typeof c?.text === "string" ? c.text : "",
            fromId: String(fromId),
            fromName: username,
            permalink: null,
            createdAtRaw: c?.timestamp ?? null,
            rawValue: c,
          });
          if (result.status === "created") {
            summary.messagesCreated += 1;
          } else if (result.status === "duplicate") {
            summary.duplicatesSkipped += 1;
          } else if (result.status === "skipped") {
            summary.errors.push({
              context: `comment:${c?.id ?? "?"}`,
              message: `SKIPPED:${result.reason ?? "unknown"}`,
            });
          }
        } catch (ingestErr) {
          summary.errors.push({
            context: `comment:${c?.id ?? "?"}`,
            message: `INGEST_ERROR:${ingestErr?.message ?? "unknown"}`,
          });
        }
      }
    }

    const nextCursor = page?.paging?.cursors?.after ?? null;
    const hasNext = Boolean(page?.paging?.next && nextCursor);
    if (!hasNext) break;
    after = nextCursor;
  }
  return { stop: false };
}

async function countNewConversations({ clientId, beforeCount }) {
  const after = await prisma.conversation.count({
    where: { clientId, provider: "INSTAGRAM" },
  });
  return Math.max(0, after - beforeCount);
}

/**
 * Poll IG comments for a single connection. Returns a summary
 * shaped like the prompt spec:
 *   { mediaChecked, commentsFetched, messagesCreated,
 *     conversationsCreated, duplicatesSkipped, errors }
 */
export async function pollInstagramCommentsForConnection(connection, { dryRun = false } = {}) {
  const summary = emptySummary();

  if (!connection?.externalAccountId) {
    summary.errors.push({
      context: `connection:${connection?.id ?? "?"}`,
      message: "NO_EXTERNAL_ACCOUNT_ID",
    });
    return summary;
  }
  if (connection.status !== "CONNECTED") {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `STATUS_NOT_CONNECTED:${connection.status}`,
    });
    return summary;
  }
  if (!hasRequiredScope(connection.scopes)) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `MISSING_REQUIRED_SCOPE:${REQUIRED_SCOPE}`,
    });
    return summary;
  }

  let fresh;
  try {
    fresh = await ensureValidAccessToken(connection);
  } catch (err) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `TOKEN_REFRESH_FAILED:${err?.message ?? "unknown"}`,
    });
    return summary;
  }
  let accessToken;
  try {
    accessToken = decryptToken(fresh?.accessToken ?? connection.accessToken);
  } catch (decryptErr) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `TOKEN_DECRYPT_FAILED:${decryptErr?.message ?? "unknown"}`,
    });
    return summary;
  }
  if (!accessToken) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: "NO_ACCESS_TOKEN",
    });
    return summary;
  }

  const beforeConvCount = await prisma.conversation.count({
    where: { clientId: connection.clientId, provider: "INSTAGRAM" },
  });

  const mediaItems = await listMediaForWorkspace({ clientId: connection.clientId });
  for (const media of mediaItems) {
    const { stop, reason } = await processMedia({
      accessToken,
      media,
      connection,
      summary,
      dryRun,
    });
    if (stop) {
      if (reason === "AUTH_FAILED") {
        await markNeedsReconnect(connection.id, "Instagram poll: 401/403 from Graph");
      }
      break;
    }
  }

  if (!dryRun) {
    summary.conversationsCreated = await countNewConversations({
      clientId: connection.clientId,
      beforeCount: beforeConvCount,
    });
    await prisma.channelConnection
      .update({
        where: { id: connection.id },
        data: { lastValidatedAt: new Date() },
      })
      .catch(() => {});
  }

  return summary;
}

/**
 * Single-workspace variant — backs the manual-sync endpoint added in
 * Prompt 03.
 */
export async function pollInstagramCommentsForWorkspace({
  clientId,
  limit,
  since,
  dryRun = false,
} = {}) {
  const summary = emptySummary();
  if (!clientId) {
    summary.errors.push({
      context: "workspace:?",
      message: "MISSING_CLIENT_ID",
    });
    return summary;
  }

  const connection = await prisma.channelConnection.findUnique({
    where: { clientId_channel: { clientId, channel: "INSTAGRAM" } },
  });
  if (!connection) {
    summary.errors.push({
      context: `workspace:${clientId}`,
      message: "NO_INSTAGRAM_CONNECTION",
    });
    return summary;
  }

  if (typeof limit !== "number" && !since) {
    return pollInstagramCommentsForConnection(connection, { dryRun });
  }

  if (!hasRequiredScope(connection.scopes)) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `MISSING_REQUIRED_SCOPE:${REQUIRED_SCOPE}`,
    });
    return summary;
  }
  if (connection.status !== "CONNECTED") {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `STATUS_NOT_CONNECTED:${connection.status}`,
    });
    return summary;
  }
  let fresh;
  try {
    fresh = await ensureValidAccessToken(connection);
  } catch (err) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `TOKEN_REFRESH_FAILED:${err?.message ?? "unknown"}`,
    });
    return summary;
  }
  let accessToken;
  try {
    accessToken = decryptToken(fresh?.accessToken ?? connection.accessToken);
  } catch (decryptErr) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `TOKEN_DECRYPT_FAILED:${decryptErr?.message ?? "unknown"}`,
    });
    return summary;
  }

  const beforeConvCount = await prisma.conversation.count({
    where: { clientId, provider: "INSTAGRAM" },
  });
  const mediaItems = await listMediaForWorkspace({ clientId, limit, since });
  for (const media of mediaItems) {
    const { stop, reason } = await processMedia({
      accessToken,
      media,
      connection,
      summary,
      dryRun,
    });
    if (stop) {
      if (reason === "AUTH_FAILED") {
        await markNeedsReconnect(connection.id, "Instagram poll: 401/403 from Graph");
      }
      break;
    }
  }
  if (!dryRun) {
    summary.conversationsCreated = await countNewConversations({
      clientId,
      beforeCount: beforeConvCount,
    });
  }
  return summary;
}

/**
 * Run a polling tick across every connected INSTAGRAM workspace.
 */
export async function pollInstagramCommentsForAllConnections({ limit = 50 } = {}) {
  const start = Date.now();
  const conns = await listPollableConnections({ limit });
  const totals = emptySummary();
  totals.connectionsScanned = conns.length;
  for (const conn of conns) {
    const summary = await pollInstagramCommentsForConnection(conn);
    mergeSummaries(totals, summary);
  }
  const elapsed = Date.now() - start;
  console.log(
    `[ig.poller] tick complete: ${totals.connectionsScanned} conns, ${totals.mediaChecked} media, ${totals.commentsFetched} fetched, ${totals.messagesCreated} created, ${totals.duplicatesSkipped} dup, ${totals.errors.length} err (${elapsed}ms)`,
  );
  return totals;
}
