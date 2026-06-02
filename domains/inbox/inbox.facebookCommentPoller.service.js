// Facebook Page comment polling service.
//
// Facebook has webhook surfaces for comments, but Prompt 01 removed
// the Meta webhook receiver in favor of polling so the Inbox doesn't
// depend on a webhook that App Review may revoke between submissions.
// This service polls `graph.facebook.com/v19.0/{post-id}/comments` per
// recently-published Facebook Page post on the worker's schedule
// (15-minute tick wired in Prompt 03) and idempotently ingests each
// comment via the shared persistence helper in
// `inbox.metaCommentIngestion.service.js`.
//
// For each CONNECTED FACEBOOK ChannelConnection:
//   1. Verify required scopes (pages_read_user_content +
//      pages_read_engagement). Skip with a clear error if missing —
//      we'd just get permission errors from Graph otherwise.
//   2. Ensure the Page access token is fresh (Facebook Page tokens
//      generally don't expire when long-lived, but the shared
//      ensureValidAccessToken handles the edge cases).
//   3. Enumerate the workspace's recently-published Facebook posts
//      (Drafts with channel=FACEBOOK and externalPostId set, within
//      a 30-day window — older posts are unlikely to attract fresh
//      comments and the per-tick cost grows linearly with the
//      window).
//   4. For each post, walk /{externalPostId}/comments (newest-first)
//      up to MAX_PAGES_PER_POST. Each comment is normalized and
//      handed to upsertExternalCommentMessage which owns the
//      idempotency check (Message.externalMessageId === commentId).
//
// Echo guard: if the comment's `from.id` equals the Page id (the
// Page replying to itself — happens when a workspace user uses the
// outbound reply path then we re-poll the same post), skip with
// reason ECHO_FROM_PAGE so the outbound Message we already wrote
// isn't duplicated as an inbound CONTACT Message.
//
// Connections are skipped if:
//   - externalAccountId is missing (no Page id stored).
//   - status !== "CONNECTED".
//   - required scopes are missing.
//   - access token decrypt or refresh fails.
//   - 401/403 from Graph → mark NEEDS_RECONNECT, stop this connection.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { ensureValidAccessToken } from "../studio/tokenRefreshService.js";
import { META_GRAPH_BASE } from "../studio/meta.constants.js";
import { upsertExternalCommentMessage } from "./inbox.metaCommentIngestion.service.js";

// Cap per post per tick. A normal published post has a handful of
// comments; this bound protects quota on a viral outlier. Newest-
// first ordering means any comments past the cap land on the next
// tick once volume drops.
const MAX_PAGES_PER_POST = 5;
const PAGE_SIZE = 100;

// Don't poll posts older than this. The /{post-id}/comments endpoint
// has no "since this comment id" filter — every poll re-walks the
// thread. Restricting to recently-published posts keeps the per-tick
// API cost bounded.
const POST_LOOKBACK_DAYS = 30;

const REQUIRED_SCOPES = ["pages_read_user_content", "pages_read_engagement"];

const FIELDS = ["id", "message", "from", "created_time", "parent", "comment_count"].join(",");

function emptySummary() {
  return {
    postsChecked: 0,
    commentsFetched: 0,
    messagesCreated: 0,
    conversationsCreated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };
}

function mergeSummaries(into, from) {
  into.postsChecked += from.postsChecked;
  into.commentsFetched += from.commentsFetched;
  into.messagesCreated += from.messagesCreated;
  into.conversationsCreated += from.conversationsCreated;
  into.duplicatesSkipped += from.duplicatesSkipped;
  if (Array.isArray(from.errors) && from.errors.length) {
    into.errors.push(...from.errors);
  }
}

/**
 * Pick the candidate connection set for the current tick. Mirrors
 * the Threads + YouTube pollers' shape.
 */
export async function listPollableConnections({ limit = 50 } = {}) {
  return prisma.channelConnection.findMany({
    where: {
      channel: "FACEBOOK",
      status: "CONNECTED",
      externalAccountId: { not: null },
    },
    orderBy: { lastValidatedAt: "asc" },
    take: limit,
  });
}

/**
 * Enumerate the workspace's published Facebook posts eligible for
 * comment polling. Draft.externalPostId is the source of truth —
 * every successful Facebook publish writes it.
 */
export async function listPostsForWorkspace({
  clientId,
  lookbackDays = POST_LOOKBACK_DAYS,
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
      channel: "FACEBOOK",
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
    postId: d.externalPostId,
    postUrl: d.externalPostUrl,
    publishedAt: d.publishedAt,
  }));
}

/**
 * Fetch one page of /{postId}/comments. Returns the raw page object
 * `{ data, paging }`. Caller iterates pagination + maps each comment.
 */
async function fetchCommentsPage({ accessToken, postId, after }) {
  const params = new URLSearchParams({
    fields: FIELDS,
    limit: String(PAGE_SIZE),
    access_token: accessToken,
  });
  if (after) params.set("after", after);
  const url = `${META_GRAPH_BASE}/${encodeURIComponent(postId)}/comments?${params.toString()}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      body?.error?.message ?? `Facebook /comments failed with ${res.status}`,
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

function hasRequiredScopes(scopes) {
  if (!Array.isArray(scopes)) return false;
  return REQUIRED_SCOPES.every((s) => scopes.includes(s));
}

/**
 * Walk one post's comments and feed each through the shared
 * idempotent upsert. Updates `summary` in place. Returns
 * { stop: boolean } — set when auth-failed so the caller bails out
 * of the whole connection.
 */
async function processPost({ accessToken, post, connection, summary, dryRun }) {
  summary.postsChecked += 1;

  let after = null;
  let pagesFetched = 0;
  while (pagesFetched < MAX_PAGES_PER_POST) {
    let page;
    try {
      page = await fetchCommentsPage({
        accessToken,
        postId: post.postId,
        after,
      });
    } catch (err) {
      const status = err?.status ?? 0;
      if (status === 401 || status === 403) {
        summary.errors.push({
          context: `post:${post.postId}`,
          message: `AUTH_FAILED:${status} ${err?.message ?? ""}`.trim(),
        });
        return { stop: true, reason: "AUTH_FAILED" };
      }
      if (status === 404 || status === 410) {
        // Post was deleted or visibility-restricted. Skip to next.
        summary.errors.push({
          context: `post:${post.postId}`,
          message: `POST_NOT_FOUND:${status}`,
        });
        return { stop: false };
      }
      if (status === 429 || status >= 500) {
        // Transient — log and bail this post (will retry next tick).
        summary.errors.push({
          context: `post:${post.postId}`,
          message: `TRANSIENT:${status} ${err?.message ?? ""}`.trim(),
        });
        return { stop: false };
      }
      summary.errors.push({
        context: `post:${post.postId}`,
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
        // Echo guard — skip the Page replying to itself.
        if (fromId && String(fromId) === String(connection.externalAccountId)) {
          summary.errors.push({
            context: `comment:${c?.id ?? "?"}`,
            message: "ECHO_FROM_PAGE",
          });
          continue;
        }
        const parentCommentId =
          c?.parent && typeof c.parent === "object" && typeof c.parent.id === "string"
            ? c.parent.id
            : null;
        try {
          const result = await upsertExternalCommentMessage({
            clientId: connection.clientId,
            provider: "FACEBOOK",
            externalAccountId: connection.externalAccountId,
            commentId: c?.id ? String(c.id) : "",
            parentPostId: post.postId,
            parentCommentId,
            body: typeof c?.message === "string" ? c.message : "",
            fromId: fromId ? String(fromId) : null,
            fromName: typeof c?.from?.name === "string" ? c.from.name : null,
            permalink: null,
            createdAtRaw: c?.created_time ?? null,
            rawValue: c,
          });
          if (result.status === "created") {
            summary.messagesCreated += 1;
            if (result.conversationId && result.__newConversation !== false) {
              // The helper doesn't surface "new vs existing
              // conversation" — count it by detecting that the
              // commentId is the first message in this conversation
              // we've seen this tick. Cheaper proxy: query message
              // count for this conversation after insert is 1. We
              // skip the extra round-trip and instead infer "new"
              // from the helper's behavior: it returns `created` for
              // the message, and the conversation is "new this
              // tick" the first time we see its id this tick.
            }
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

/**
 * Track distinct conversations touched per tick so we can report
 * `conversationsCreated`. The shared helper returns `conversationId`
 * regardless of whether the conversation was created or pre-existing;
 * we layer this on top by counting the conversationIds that didn't
 * exist before the tick started.
 */
async function countNewConversations({ clientId, beforeCount }) {
  const after = await prisma.conversation.count({
    where: { clientId, provider: "FACEBOOK" },
  });
  return Math.max(0, after - beforeCount);
}

/**
 * Poll Facebook comments for a single connection. Returns a summary
 * shaped like the prompt spec:
 *   { postsChecked, commentsFetched, messagesCreated,
 *     conversationsCreated, duplicatesSkipped, errors }
 */
export async function pollFacebookCommentsForConnection(connection, { dryRun = false } = {}) {
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
  if (!hasRequiredScopes(connection.scopes)) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `MISSING_REQUIRED_SCOPE:${REQUIRED_SCOPES.join(",")}`,
    });
    return summary;
  }

  // Refresh near-expiry tokens via the shared service. Returns the
  // connection row with accessToken still ciphertext when no refresh
  // happened — always run through decryptToken.
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
    where: { clientId: connection.clientId, provider: "FACEBOOK" },
  });

  const posts = await listPostsForWorkspace({ clientId: connection.clientId });
  for (const post of posts) {
    const { stop, reason } = await processPost({
      accessToken,
      post,
      connection,
      summary,
      dryRun,
    });
    if (stop) {
      if (reason === "AUTH_FAILED") {
        await markNeedsReconnect(connection.id, "Facebook poll: 401/403 from Graph");
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
 * Single-workspace variant. Used by the manual-sync admin endpoint
 * (Prompt 03 wires the route). Looks up the workspace's FACEBOOK
 * connection and delegates to pollFacebookCommentsForConnection.
 *
 * `limit` caps the number of posts walked; `since` overrides the
 * 30-day lookback floor; `dryRun` skips writes.
 */
export async function pollFacebookCommentsForWorkspace({
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
    where: { clientId_channel: { clientId, channel: "FACEBOOK" } },
  });
  if (!connection) {
    summary.errors.push({
      context: `workspace:${clientId}`,
      message: "NO_FACEBOOK_CONNECTION",
    });
    return summary;
  }

  // When the caller passes a `limit` or `since`, override the
  // per-connection post-enumeration by computing the post set up
  // front and delegating per-post processing into the connection
  // helper. The default per-connection behavior (no caller-supplied
  // bounds) is identical to pollFacebookCommentsForConnection, so we
  // can call straight through.
  if (typeof limit !== "number" && !since) {
    return pollFacebookCommentsForConnection(connection, { dryRun });
  }

  // Custom bounds — re-implement the inner loop with the caller's
  // post set. Same auth / scope guards as the per-connection path.
  if (!hasRequiredScopes(connection.scopes)) {
    summary.errors.push({
      context: `connection:${connection.id}`,
      message: `MISSING_REQUIRED_SCOPE:${REQUIRED_SCOPES.join(",")}`,
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
    where: { clientId, provider: "FACEBOOK" },
  });
  const posts = await listPostsForWorkspace({ clientId, limit, since });
  for (const post of posts) {
    const { stop, reason } = await processPost({
      accessToken,
      post,
      connection,
      summary,
      dryRun,
    });
    if (stop) {
      if (reason === "AUTH_FAILED") {
        await markNeedsReconnect(connection.id, "Facebook poll: 401/403 from Graph");
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
 * Run a polling tick across every connected FACEBOOK workspace.
 * Called by the worker on the cron schedule (Prompt 03).
 */
export async function pollFacebookCommentsForAllConnections({ limit = 50 } = {}) {
  const start = Date.now();
  const conns = await listPollableConnections({ limit });
  const totals = emptySummary();
  totals.connectionsScanned = conns.length;
  for (const conn of conns) {
    const summary = await pollFacebookCommentsForConnection(conn);
    mergeSummaries(totals, summary);
  }
  const elapsed = Date.now() - start;
  console.log(
    `[fb.poller] tick complete: ${totals.connectionsScanned} conns, ${totals.postsChecked} posts, ${totals.commentsFetched} fetched, ${totals.messagesCreated} created, ${totals.duplicatesSkipped} dup, ${totals.errors.length} err (${elapsed}ms)`,
  );
  return totals;
}
