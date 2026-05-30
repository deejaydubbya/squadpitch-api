// Threads reply polling service.
//
// Threads has no inbound webhook for replies on a user's posts
// (the Threads Webhook product covers a narrow set of events, not
// reply ingestion at the time of writing). This service polls
// graph.threads.net/{post-id}/conversation per published Threads
// post on a 15-minute interval and idempotently ingests each
// reply.
//
// For each CONNECTED Threads ChannelConnection:
//   1. Ensure access token is fresh (Threads uses a 60-day
//      long-lived token refreshed via /refresh_access_token; the
//      existing tokenRefreshService handles this).
//   2. Enumerate the workspace's recently-published Threads posts
//      (Drafts with channel=THREADS and externalPostId set).
//   3. For each post, call /{externalPostId}/conversation
//      (newest-first), iterate top-level + nested replies.
//   4. Normalize → ingestThreadsReply.
//
// Idempotency lives in the ingestion layer (reply id keyed),
// so re-walking the same /conversation on every tick is safe.
//
// Connections are skipped if:
//   - externalAccountId is missing (no Threads user id stored).
//   - status !== "CONNECTED".
//   - access token decrypt or refresh fails.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { ingestThreadsReply } from "./inbox.threads.ingestion.service.js";
import { ensureValidAccessToken } from "../studio/tokenRefreshService.js";
import { THREADS_GRAPH_BASE } from "../studio/threads.constants.js";

// Restricts how much of a single post's conversation we walk per
// tick. Most posts get a handful of replies; the cap protects
// quota on a viral outlier. Newest-first ordering means missed
// replies land on the next tick once volume drops.
const REPLIES_PER_POST = 50;

// Don't poll posts older than this. /conversation re-walks the
// full thread on every call (Threads has no "since this reply id"
// filter), so restricting to recently-published posts keeps the
// per-tick API cost bounded.
const POST_LOOKBACK_DAYS = 30;

/**
 * Pick the candidate connection set for the current tick.
 * Skips connections that haven't completed OAuth (no user id).
 */
export async function listPollableConnections({ limit = 50 } = {}) {
  const rows = await prisma.channelConnection.findMany({
    where: {
      channel: "THREADS",
      status: "CONNECTED",
      externalAccountId: { not: null },
    },
    orderBy: { lastValidatedAt: "asc" },
    take: limit,
  });
  return rows;
}

/**
 * Enumerate the workspace's published Threads posts eligible for
 * reply polling. Draft.externalPostId is the source of truth —
 * every successful Threads publish writes it. publishedAt within
 * POST_LOOKBACK_DAYS limits the polling cost.
 */
export async function listPostsForWorkspace({ clientId, lookbackDays = POST_LOOKBACK_DAYS }) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60_000);
  const drafts = await prisma.draft.findMany({
    where: {
      clientId,
      channel: "THREADS",
      externalPostId: { not: null },
      publishedAt: { gte: since },
    },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      externalPostId: true,
      externalPostUrl: true,
      body: true,
    },
  });
  return drafts.map((d) => ({
    postId: d.externalPostId,
    postUrl: d.externalPostUrl,
    postTitle: extractTitle(d.body),
  }));
}

function extractTitle(body) {
  if (typeof body !== "string" || body.length === 0) return "(untitled)";
  const firstLine = body.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 0 ? firstLine.slice(0, 120) : "(untitled)";
}

/**
 * Fetch /{postId}/conversation for one post. Returns an array of
 * raw reply objects. Caller normalizes + hands to ingest.
 */
async function fetchConversation({ accessToken, postId }) {
  const fields = ["id", "text", "username", "user_id", "timestamp", "permalink", "replied_to"].join(",");
  const url =
    `${THREADS_GRAPH_BASE}/${encodeURIComponent(postId)}/conversation` +
    `?fields=${encodeURIComponent(fields)}` +
    `&reverse=true` +
    `&limit=${REPLIES_PER_POST}` +
    `&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      body?.error?.message ?? `Threads /conversation failed with ${res.status}`,
    );
    err.status = res.status;
    err.code = res.status === 401 || res.status === 403 ? "AUTH_FAILED" : "PROVIDER_FAILED";
    err.threadsError = body?.error ?? null;
    throw err;
  }
  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * Poll replies for a single connection. Returns a summary.
 */
export async function pollThreadsRepliesForConnection(connection) {
  const summary = {
    connectionId: connection.id,
    clientId: connection.clientId,
    threadsUserId: connection.externalAccountId,
    postsScanned: 0,
    fetched: 0,
    created: 0,
    duplicate: 0,
    skipped: 0,
    error: null,
  };
  if (!connection.externalAccountId) {
    summary.skipped += 1;
    summary.error = "NO_USER";
    return summary;
  }

  // Refresh near-expiry tokens via the shared service so Threads'
  // 60-day token roll-over is handled in exactly one place.
  // ensureValidAccessToken returns the connection row unchanged
  // when the token isn't near expiry, so accessToken on that row
  // is still ciphertext — we always run it through decryptToken.
  let fresh;
  try {
    fresh = await ensureValidAccessToken(connection);
  } catch (err) {
    summary.error = "TOKEN_REFRESH_FAILED";
    console.warn("[threads.poller] token refresh failed:", {
      connectionId: connection.id,
      err: err?.message,
    });
    return summary;
  }
  let accessToken;
  try {
    accessToken = decryptToken(fresh?.accessToken ?? connection.accessToken);
  } catch (decryptErr) {
    summary.error = "TOKEN_DECRYPT_FAILED";
    console.warn("[threads.poller] token decrypt failed:", {
      connectionId: connection.id,
      err: decryptErr?.message,
    });
    return summary;
  }
  if (!accessToken) {
    summary.error = "NO_ACCESS_TOKEN";
    return summary;
  }

  const posts = await listPostsForWorkspace({ clientId: connection.clientId });
  summary.postsScanned = posts.length;

  for (const post of posts) {
    let replies;
    try {
      replies = await fetchConversation({ accessToken, postId: post.postId });
    } catch (err) {
      // 404 / "media not found" on a per-post basis is non-fatal —
      // post was deleted or visibility-restricted. Continue with
      // the rest. Real auth failures bubble up — surface once.
      if (err.status === 404) {
        console.warn("[threads.poller] skipping post:", {
          postId: post.postId,
          reason: "media_not_found",
        });
        continue;
      }
      if (err.code === "AUTH_FAILED") {
        summary.error = "AUTH_FAILED";
        return summary;
      }
      summary.error = err?.message ?? "FETCH_CONVERSATION_FAILED";
      console.error("[threads.poller] /conversation failed:", {
        postId: post.postId,
        err: err?.message,
      });
      continue;
    }

    summary.fetched += replies.length;

    for (const raw of replies) {
      // Threads' /conversation includes the post itself as the
      // first item when reverse=true is set (varies by API
      // version) — skip the root by comparing ids.
      if (raw?.id && String(raw.id) === String(post.postId)) continue;

      const normalized = normalizeThreadsReply({
        raw,
        post,
        threadsUserId: connection.externalAccountId,
      });
      if (!normalized) {
        summary.skipped += 1;
        continue;
      }
      try {
        const result = await ingestThreadsReply(normalized);
        if (result.status === "created") summary.created += 1;
        else if (result.status === "duplicate") summary.duplicate += 1;
        else summary.skipped += 1;
      } catch (ingestErr) {
        summary.skipped += 1;
        console.error("[threads.poller] ingestThreadsReply failed:", {
          replyId: raw?.id,
          err: ingestErr?.message,
        });
      }
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
 * Map a raw Threads /conversation reply object to the normalized
 * shape ingestThreadsReply expects. Returns null on malformed
 * payloads.
 */
export function normalizeThreadsReply({ raw, post, threadsUserId }) {
  if (!raw || typeof raw !== "object") return null;
  const replyId = raw.id ? String(raw.id) : null;
  if (!replyId) return null;
  // replied_to is the immediate parent reply id when this reply is
  // nested (reply-to-reply). When the reply is to the root post,
  // some Threads API responses omit replied_to entirely; we treat
  // that as a top-level reply (parentId=null).
  const repliedTo =
    raw.replied_to && typeof raw.replied_to === "object"
      ? raw.replied_to.id ?? null
      : typeof raw.replied_to === "string"
        ? raw.replied_to
        : null;
  const parentId =
    repliedTo && String(repliedTo) !== String(post.postId)
      ? String(repliedTo)
      : null;

  return {
    threadsUserId,
    postId: post.postId,
    postTitle: post.postTitle,
    replyId,
    parentId,
    text: typeof raw.text === "string" ? raw.text : null,
    author: {
      userId: raw.user_id != null ? String(raw.user_id) : null,
      username: typeof raw.username === "string" ? raw.username : null,
    },
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : null,
    permalink: typeof raw.permalink === "string" ? raw.permalink : null,
  };
}

/**
 * Run a single polling tick across all candidate connections.
 * Called by the worker on the cron schedule + by the manual
 * "Sync Threads replies now" admin route.
 */
export async function runThreadsReplyPollTick({ batchSize = 50 } = {}) {
  const start = Date.now();
  const conns = await listPollableConnections({ limit: batchSize });
  const totals = {
    connections: conns.length,
    postsScanned: 0,
    fetched: 0,
    created: 0,
    duplicate: 0,
    errors: 0,
  };
  for (const conn of conns) {
    const summary = await pollThreadsRepliesForConnection(conn);
    totals.postsScanned += summary.postsScanned;
    totals.fetched += summary.fetched;
    totals.created += summary.created;
    totals.duplicate += summary.duplicate;
    if (summary.error) totals.errors += 1;
  }
  const elapsed = Date.now() - start;
  console.log(
    `[threads.poller] tick complete: ${totals.connections} conns, ${totals.postsScanned} posts, ${totals.fetched} fetched, ${totals.created} created, ${totals.duplicate} dup, ${totals.errors} err (${elapsed}ms)`,
  );
  return totals;
}
