// Instagram Graph API adapter for publishing.
//
// Implements the 2-step container-based IG publish flow:
//   1. POST /{ig-user-id}/media        -> create container
//   2. POST /{ig-user-id}/media_publish -> publish container
//   3. GET  /{media-id}?fields=permalink -> resolve permalink
//
// Only single-image posts in Phase 2. Carousels/video/Reels are out of
// scope and will be added when we lift the "minimal" constraint.

import { META_GRAPH_BASE } from "../../meta.constants.js";

const GRAPH_BASE = META_GRAPH_BASE;
const IG_CAPTION_MAX = 2200;

class InstagramPublishError extends Error {
  constructor(message, { status, code, metaError } = {}) {
    super(message);
    this.name = "InstagramPublishError";
    this.status = status ?? 502;
    this.code = code ?? "INSTAGRAM_PUBLISH_FAILED";
    this.metaError = metaError ?? null;
  }
}

function buildCaption(draft) {
  const body = draft.body ?? "";
  const tags = Array.isArray(draft.hashtags) ? draft.hashtags : [];
  const tagLine = tags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .join(" ");
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

async function metaCall(url, params) {
  const res = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new InstagramPublishError(
      body?.error?.message ?? `Instagram call failed with ${res.status}`,
      { status: res.status, metaError: body?.error ?? body }
    );
  }
  return body;
}

/**
 * Poll a media container until it finishes processing (for video/Reels).
 * Max 30 polls × 2s = 60s timeout.
 */
async function pollContainerUntilReady(containerId, token) {
  const MAX_POLLS = 30;
  const POLL_INTERVAL_MS = 2000;

  for (let i = 0; i < MAX_POLLS; i++) {
    const res = await fetch(
      `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`
    );
    const body = await res.json().catch(() => ({}));

    if (body.status_code === "FINISHED") return;
    if (body.status_code === "ERROR") {
      throw new InstagramPublishError(
        "Instagram Reels container processing failed",
        { metaError: body }
      );
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new InstagramPublishError(
    "Instagram Reels container timed out after 60s",
    { status: 504, code: "INSTAGRAM_CONTAINER_TIMEOUT" }
  );
}

export const instagramAdapter = {
  channel: "INSTAGRAM",

  /**
   * Validates that the draft can be published to Instagram:
   *  - a media URL must exist (either draft.mediaUrl or client mediaProfile asset)
   *  - caption must not exceed 2200 chars
   * Returns { mediaUrl, caption } on success.
   */
  async validatePublishTarget({ draft, client }) {
    const mediaUrl = pickMediaUrl(draft, client);
    if (!mediaUrl) {
      throw new InstagramPublishError(
        "Instagram requires a media URL. Set draft.mediaUrl or a mediaProfile asset.",
        { status: 400, code: "PUBLISH_FAILED_NO_MEDIA" }
      );
    }
    const caption = buildCaption(draft);
    if (caption.length > IG_CAPTION_MAX) {
      throw new InstagramPublishError(
        `Instagram caption exceeds ${IG_CAPTION_MAX} characters (${caption.length})`,
        { status: 400, code: "PUBLISH_FAILED_CAPTION_TOO_LONG" }
      );
    }
    return { mediaUrl, caption };
  },

  async publishPost({ draft, connection, client }) {
    const { mediaUrl, caption } = await this.validatePublishTarget({ draft, client });
    const igUserId = connection.externalAccountId;
    const token = connection.accessToken; // already decrypted by caller
    const isVideo = draft.mediaType === "video";
    if (!igUserId) {
      throw new InstagramPublishError(
        "Connection is missing an Instagram user id",
        { status: 500, code: "INSTAGRAM_CONNECTION_INVALID" }
      );
    }

    // Step 1: create container (image vs Reels)
    let containerParams;
    if (isVideo) {
      containerParams = {
        media_type: "REELS",
        video_url: mediaUrl,
        caption,
        access_token: token,
      };
    } else {
      containerParams = {
        image_url: mediaUrl,
        caption,
        access_token: token,
      };
    }

    const container = await metaCall(
      `${GRAPH_BASE}/${igUserId}/media`,
      containerParams
    );
    if (!container?.id) {
      throw new InstagramPublishError(
        "Instagram media container response missing id",
        { metaError: container }
      );
    }

    // Step 1b: for video/Reels, poll until container is ready
    if (isVideo) {
      await pollContainerUntilReady(container.id, token);
    }

    // Step 2: publish container
    const published = await metaCall(
      `${GRAPH_BASE}/${igUserId}/media_publish`,
      { creation_id: container.id, access_token: token }
    );
    if (!published?.id) {
      throw new InstagramPublishError(
        "Instagram publish response missing media id",
        { metaError: published }
      );
    }

    // Step 3: resolve permalink
    let externalPostUrl = null;
    try {
      const metaRes = await fetch(
        `${GRAPH_BASE}/${published.id}?fields=permalink&access_token=${encodeURIComponent(
          token
        )}`
      );
      const metaBody = await metaRes.json().catch(() => ({}));
      if (metaRes.ok && metaBody?.permalink) {
        externalPostUrl = metaBody.permalink;
      }
    } catch {
      // non-fatal — externalPostId is still useful on its own
    }

    return { externalPostId: published.id, externalPostUrl };
  },
};

export { InstagramPublishError };
