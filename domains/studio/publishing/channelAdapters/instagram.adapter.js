// Instagram API adapter for publishing.
//
// Implements the 2-step container-based IG publish flow:
//   1. POST /{ig-user-id}/media        -> create container
//   2. POST /{ig-user-id}/media_publish -> publish container
//   3. GET  /{media-id}?fields=permalink -> resolve permalink
//
// AFTER Prompt 01's migration the connection's `accessToken` is a
// direct Instagram long-lived USER token (instagram_business_*
// scopes), not a Facebook Page access token. The container/publish
// endpoints below currently keep working when called against
// graph.facebook.com with the IG user token; if a future runtime
// test shows they need to move to graph.instagram.com, the
// INSTAGRAM_GRAPH_BASE constant in `../../meta.constants.js` is
// ready — swap the import + GRAPH_BASE assignment below.
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
 * Poll a media container until it finishes processing.
 * Instagram must download and process the media from the URL before it can
 * be published. Images are usually fast (~1-5s), videos/Reels can take up to
 * 60s. Without this check, the /media_publish call returns
 * "Media ID is not available".
 */
async function pollContainerUntilReady(containerId, token, { maxPolls = 30, intervalMs = 2000 } = {}) {
  for (let i = 0; i < maxPolls; i++) {
    const res = await fetch(
      `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`
    );
    const body = await res.json().catch(() => ({}));

    if (body.status_code === "FINISHED") return;
    if (body.status_code === "ERROR") {
      throw new InstagramPublishError(
        `Instagram container processing failed${body.status ? `: ${body.status}` : ""}`,
        { metaError: body }
      );
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const timeoutSec = Math.round((maxPolls * intervalMs) / 1000);
  throw new InstagramPublishError(
    `Instagram container timed out after ${timeoutSec}s`,
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
    // Direct Instagram long-lived USER token (Prompt 01 migration);
    // already decrypted by the caller. Was a Page access token in
    // the pre-migration flow.
    const token = connection.accessToken;
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

    // Step 1b: poll until container is ready.
    // Instagram must download the media from the URL before publishing.
    // Images: usually 1-5s, poll up to ~15s. Videos/Reels: up to 60s.
    if (isVideo) {
      await pollContainerUntilReady(container.id, token, { maxPolls: 30, intervalMs: 2000 });
    } else {
      await pollContainerUntilReady(container.id, token, { maxPolls: 10, intervalMs: 1500 });
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
