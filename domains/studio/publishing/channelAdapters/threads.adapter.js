// Threads (Meta) publishing adapter.
//
// Threads uses a two-step container/publish flow modeled after the
// Instagram Graph API:
//   1. POST /me/threads               — create container with media_type
//                                       + text + (image_url|video_url)
//   2. POST /me/threads_publish       — publish creation_id
//   3. GET  /{thread-id}?fields=permalink — resolve permalink
//
// Image / video containers must be polled via
// GET /{container-id}?fields=status until status == 'FINISHED' before
// publishing — same pattern as Instagram. Text containers can be
// published immediately.
//
// Spec: https://developers.facebook.com/docs/threads/reference/publishing/

import { THREADS_GRAPH_BASE } from "../../threads.constants.js";

const THREADS_TEXT_MAX = 500;

class ThreadsPublishError extends Error {
  constructor(message, { status, code, threadsError } = {}) {
    super(message);
    this.name = "ThreadsPublishError";
    this.status = status ?? 502;
    this.code = code ?? "THREADS_PUBLISH_FAILED";
    this.threadsError = threadsError ?? null;
  }
}

function buildText(draft) {
  // Threads has no separate "first comment" feature for hashtags, so
  // we append hashtags to the body the same way Instagram does — but
  // skip ones already present to keep things tidy.
  const body = draft.body ?? "";
  const tags = Array.isArray(draft.hashtags) ? draft.hashtags : [];
  const bodyLower = body.toLowerCase();
  const newTags = tags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => !bodyLower.includes(t.toLowerCase()));
  const tagLine = newTags.join(" ");
  return tagLine ? `${body}\n\n${tagLine}` : body;
}

function pickMediaUrl(draft, client) {
  if (draft.mediaUrl) return draft.mediaUrl;
  const asset = client?.mediaProfile?.assetLibraryJson;
  if (Array.isArray(asset) && asset.length > 0 && asset[0]?.url) {
    return asset[0].url;
  }
  return null;
}

async function threadsPost(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ThreadsPublishError(
      body?.error?.message ?? `Threads call failed with ${res.status}`,
      { status: res.status, threadsError: body?.error ?? body }
    );
  }
  return body;
}

// Poll a Threads container until status_code transitions out of
// IN_PROGRESS. Same shape as the Instagram poller — Threads returns
// status_code values: IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED.
async function pollContainerUntilReady(
  containerId,
  token,
  { maxPolls = 30, intervalMs = 2000 } = {}
) {
  for (let i = 0; i < maxPolls; i++) {
    const res = await fetch(
      `${THREADS_GRAPH_BASE}/${encodeURIComponent(containerId)}` +
        `?fields=status,error_message&access_token=${encodeURIComponent(token)}`
    );
    const body = await res.json().catch(() => ({}));
    const status = body?.status;

    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new ThreadsPublishError(
        `Threads container ${status.toLowerCase()}${
          body?.error_message ? `: ${body.error_message}` : ""
        }`,
        { threadsError: body }
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const timeoutSec = Math.round((maxPolls * intervalMs) / 1000);
  throw new ThreadsPublishError(
    `Threads container timed out after ${timeoutSec}s`,
    { status: 504, code: "THREADS_CONTAINER_TIMEOUT" }
  );
}

export const threadsAdapter = {
  channel: "THREADS",

  // Validates that the draft can be published to Threads:
  //   - text length <= 500
  //   - if mediaType=video, mediaUrl required
  //   - if mediaType=image, mediaUrl required
  //   - if no mediaType, treat as text-only (Threads supports text-only)
  // Returns { mediaUrl, mediaType, text } on success.
  async validatePublishTarget({ draft, client }) {
    const text = buildText(draft);
    if (text.length > THREADS_TEXT_MAX) {
      throw new ThreadsPublishError(
        `Threads post exceeds ${THREADS_TEXT_MAX} characters (${text.length})`,
        { status: 400, code: "PUBLISH_FAILED_TEXT_TOO_LONG" }
      );
    }

    const mediaType = (draft.mediaType ?? "").toLowerCase();
    const isVideo = mediaType === "video";
    const isImage = mediaType === "image";
    let mediaUrl = null;
    if (isVideo || isImage) {
      mediaUrl = pickMediaUrl(draft, client);
      if (!mediaUrl) {
        throw new ThreadsPublishError(
          `Threads ${mediaType} post requires a media URL`,
          { status: 400, code: "PUBLISH_FAILED_NO_MEDIA" }
        );
      }
    }

    return {
      text,
      mediaUrl,
      mediaContainerType: isVideo ? "VIDEO" : isImage ? "IMAGE" : "TEXT",
    };
  },

  async publishPost({ draft, connection, client }) {
    const { text, mediaUrl, mediaContainerType } = await this.validatePublishTarget({
      draft,
      client,
    });
    const userId = connection.externalAccountId;
    const token = connection.accessToken;
    if (!userId) {
      throw new ThreadsPublishError(
        "Connection is missing a Threads user id",
        { status: 500, code: "THREADS_CONNECTION_INVALID" }
      );
    }

    // Step 1: create container
    const containerParams = {
      media_type: mediaContainerType,
      text,
      access_token: token,
    };
    if (mediaContainerType === "IMAGE") containerParams.image_url = mediaUrl;
    if (mediaContainerType === "VIDEO") containerParams.video_url = mediaUrl;

    const container = await threadsPost(
      `${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads`,
      containerParams
    );
    if (!container?.id) {
      throw new ThreadsPublishError(
        "Threads container response missing id",
        { threadsError: container }
      );
    }

    // Step 1b: poll container readiness for media posts.
    // Text posts are publishable immediately and skip this step.
    if (mediaContainerType === "VIDEO") {
      await pollContainerUntilReady(container.id, token, {
        maxPolls: 30,
        intervalMs: 2000,
      });
    } else if (mediaContainerType === "IMAGE") {
      await pollContainerUntilReady(container.id, token, {
        maxPolls: 12,
        intervalMs: 1500,
      });
    }

    // Step 2: publish container
    const published = await threadsPost(
      `${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads_publish`,
      {
        creation_id: container.id,
        access_token: token,
      }
    );
    if (!published?.id) {
      throw new ThreadsPublishError(
        "Threads publish response missing thread id",
        { threadsError: published }
      );
    }

    // Step 3: resolve permalink (best-effort)
    let externalPostUrl = null;
    try {
      const permaRes = await fetch(
        `${THREADS_GRAPH_BASE}/${encodeURIComponent(published.id)}` +
          `?fields=permalink&access_token=${encodeURIComponent(token)}`
      );
      const permaBody = await permaRes.json().catch(() => ({}));
      if (permaRes.ok && permaBody?.permalink) {
        externalPostUrl = permaBody.permalink;
      }
    } catch {
      // non-fatal — externalPostId is enough
    }

    return { externalPostId: String(published.id), externalPostUrl };
  },
};

export { ThreadsPublishError };
