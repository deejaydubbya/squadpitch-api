// YouTube comment polling service.
//
// YouTube has no webhook for comments — the PubSubHubbub feed only
// notifies on new uploads, not on comment activity. We poll every
// 15 minutes per connected channel. For each CONNECTED YouTube
// ChannelConnection:
//   1. Refresh access token if near expiry.
//   2. Enumerate the workspace's recently-published YouTube videos
//      (Drafts with channel=YOUTUBE and externalPostId set).
//   3. For each video, call commentThreads.list (order=time, newest
//      first) up to MAX_PAGES_PER_VIDEO pages.
//   4. Normalize each comment + its replies → ingestYouTubeComment.
//
// Idempotency is the ingestion layer's responsibility — re-fetching
// the same page on every tick is safe.
//
// Connections are skipped if:
//   - externalAccountId is missing (no channel id stored).
//   - status !== "CONNECTED".
//   - accessToken decrypt fails.
//   - token refresh fails (refresh service flips status itself).

import { prisma } from "../../prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import { ingestYouTubeComment } from "./inbox.youtube.ingestion.service.js";
import {
  listCommentThreads,
  refreshAccessToken,
} from "../studio/oauth/youtube.oauth.js";

// Soft cap per video — most published videos accumulate a handful
// of comments. The cap protects quota on a viral outlier without
// dropping coverage (newest-first ordering means missed comments
// land on the next tick once volume drops).
const MAX_PAGES_PER_VIDEO = 3;
const PAGE_SIZE = 50;

// Don't poll videos older than this. YouTube's commentThreads API
// has no "since this comment id" filter — every poll re-walks the
// page. Restricting to recently-published videos keeps the per-
// tick API cost bounded and biases coverage toward the videos
// most likely to get fresh comments.
const VIDEO_LOOKBACK_DAYS = 30;

const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Pick the candidate connection set for the current tick.
 * Skips connections that haven't completed OAuth (no channel id).
 */
export async function listPollableConnections({ limit = 50 } = {}) {
  const rows = await prisma.channelConnection.findMany({
    where: {
      channel: "YOUTUBE",
      status: "CONNECTED",
      externalAccountId: { not: null },
    },
    orderBy: { lastValidatedAt: "asc" },
    take: limit,
  });
  return rows;
}

/**
 * Enumerate the workspace's published YouTube videos that are
 * eligible for comment polling. We use Draft as the source of
 * truth — every successful YouTube publish writes externalPostId
 * (the video id) on the originating Draft row.
 */
export async function listVideosForWorkspace({ clientId, lookbackDays = VIDEO_LOOKBACK_DAYS }) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60_000);
  const drafts = await prisma.draft.findMany({
    where: {
      clientId,
      channel: "YOUTUBE",
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
    videoId: d.externalPostId,
    videoUrl: d.externalPostUrl,
    // Body line 1 is typically the title-ish hook; the publish
    // pipeline doesn't store the title separately, so this is the
    // closest signal we have. Falls back to "(untitled)".
    videoTitle: extractTitle(d.body),
  }));
}

function extractTitle(body) {
  if (typeof body !== "string" || body.length === 0) return "(untitled)";
  const firstLine = body.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 0 ? firstLine.slice(0, 120) : "(untitled)";
}

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
  } catch {}
}

/**
 * Poll comments for a single connection. Returns a summary.
 */
export async function pollYouTubeCommentsForConnection(connection) {
  const summary = {
    connectionId: connection.id,
    clientId: connection.clientId,
    channelId: connection.externalAccountId,
    videosScanned: 0,
    fetched: 0,
    created: 0,
    duplicate: 0,
    skipped: 0,
    error: null,
  };
  if (!connection.externalAccountId) {
    summary.skipped += 1;
    summary.error = "NO_CHANNEL";
    return summary;
  }

  let accessToken;
  try {
    accessToken = await ensureFreshToken(connection);
  } catch (err) {
    summary.error = err?.code ?? "TOKEN_REFRESH_FAILED";
    return summary;
  }

  const videos = await listVideosForWorkspace({ clientId: connection.clientId });
  summary.videosScanned = videos.length;

  for (const video of videos) {
    let pageToken = null;
    let pagesFetched = 0;
    while (pagesFetched < MAX_PAGES_PER_VIDEO) {
      let page;
      try {
        page = await listCommentThreads({
          accessToken,
          videoId: video.videoId,
          pageToken,
          maxResults: PAGE_SIZE,
        });
      } catch (err) {
        // commentsDisabled / videoNotFound on a per-video basis is
        // not fatal — skip that video and continue with the rest.
        // Real auth failures (401) would have been caught upstream.
        const status = err?.status ?? 0;
        const code = err?.youtubeError?.error?.errors?.[0]?.reason ?? null;
        if (status === 404 || code === "commentsDisabled" || code === "videoNotFound") {
          console.warn("[youtube.poller] skipping video:", {
            videoId: video.videoId,
            reason: code ?? `http_${status}`,
          });
          break;
        }
        summary.error = err?.message ?? "LIST_COMMENT_THREADS_FAILED";
        console.error("[youtube.poller] commentThreads.list failed:", {
          videoId: video.videoId,
          err: err?.message,
        });
        break;
      }
      pagesFetched += 1;
      summary.fetched += page.items.length;

      for (const thread of page.items) {
        const top = extractTopLevelComment({ thread, video, channelId: connection.externalAccountId });
        if (top) await tally(summary, await ingestSafe(top));

        const replies = Array.isArray(thread?.replies?.comments)
          ? thread.replies.comments
          : [];
        for (const reply of replies) {
          const r = extractReplyComment({
            reply,
            parentId: thread?.id,
            video,
            channelId: connection.externalAccountId,
          });
          if (r) await tally(summary, await ingestSafe(r));
        }
      }
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
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

async function ingestSafe(comment) {
  try {
    return await ingestYouTubeComment(comment);
  } catch (err) {
    console.error("[youtube.poller] ingestYouTubeComment failed:", {
      commentId: comment?.commentId,
      err: err?.message,
    });
    return { status: "skipped", reason: "INGEST_ERROR" };
  }
}

function tally(summary, result) {
  if (result.status === "created") summary.created += 1;
  else if (result.status === "duplicate") summary.duplicate += 1;
  else summary.skipped += 1;
}

/**
 * Normalize a commentThread top-level comment to the ingestion
 * shape. Returns null when the payload is too malformed.
 */
export function extractTopLevelComment({ thread, video, channelId }) {
  const sn = thread?.snippet?.topLevelComment?.snippet;
  const commentId = thread?.snippet?.topLevelComment?.id;
  if (!sn || !commentId) return null;
  return {
    channelId,
    videoId: video.videoId,
    videoTitle: video.videoTitle,
    commentId,
    parentId: null,
    text: typeof sn.textOriginal === "string" ? sn.textOriginal : sn.textDisplay ?? null,
    author: {
      channelId:
        typeof sn.authorChannelId?.value === "string" ? sn.authorChannelId.value : null,
      displayName:
        typeof sn.authorDisplayName === "string" ? sn.authorDisplayName : null,
      profileImageUrl:
        typeof sn.authorProfileImageUrl === "string" ? sn.authorProfileImageUrl : null,
    },
    publishedAt: typeof sn.publishedAt === "string" ? sn.publishedAt : null,
    sourceUrl: buildCommentUrl({ videoId: video.videoId, commentId }),
  };
}

/**
 * Normalize a reply comment to the ingestion shape.
 */
export function extractReplyComment({ reply, parentId, video, channelId }) {
  const sn = reply?.snippet;
  const commentId = reply?.id;
  if (!sn || !commentId) return null;
  return {
    channelId,
    videoId: video.videoId,
    videoTitle: video.videoTitle,
    commentId,
    parentId: parentId ?? sn.parentId ?? null,
    text: typeof sn.textOriginal === "string" ? sn.textOriginal : sn.textDisplay ?? null,
    author: {
      channelId:
        typeof sn.authorChannelId?.value === "string" ? sn.authorChannelId.value : null,
      displayName:
        typeof sn.authorDisplayName === "string" ? sn.authorDisplayName : null,
      profileImageUrl:
        typeof sn.authorProfileImageUrl === "string" ? sn.authorProfileImageUrl : null,
    },
    publishedAt: typeof sn.publishedAt === "string" ? sn.publishedAt : null,
    sourceUrl: buildCommentUrl({ videoId: video.videoId, commentId }),
  };
}

function buildCommentUrl({ videoId, commentId }) {
  if (!videoId || !commentId) return null;
  return `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`;
}

/**
 * Run a single polling tick across all candidate connections.
 * Called by the worker on the cron schedule + by the manual
 * "Sync YouTube comments now" admin route.
 */
export async function runYouTubeCommentPollTick({ batchSize = 50 } = {}) {
  const start = Date.now();
  const conns = await listPollableConnections({ limit: batchSize });
  const totals = {
    connections: conns.length,
    videosScanned: 0,
    fetched: 0,
    created: 0,
    duplicate: 0,
    errors: 0,
  };
  for (const conn of conns) {
    const summary = await pollYouTubeCommentsForConnection(conn);
    totals.videosScanned += summary.videosScanned;
    totals.fetched += summary.fetched;
    totals.created += summary.created;
    totals.duplicate += summary.duplicate;
    if (summary.error) totals.errors += 1;
  }
  const elapsed = Date.now() - start;
  console.log(
    `[youtube.poller] tick complete: ${totals.connections} conns, ${totals.videosScanned} videos, ${totals.fetched} fetched, ${totals.created} created, ${totals.duplicate} dup, ${totals.errors} err (${elapsed}ms)`,
  );
  return totals;
}
