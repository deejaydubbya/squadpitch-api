// Facebook Page publishing adapter.
//
// Publish flow:
//   With image: POST /{page-id}/photos  (url + caption)
//   Text-only:  POST /{page-id}/feed    (message)
//   Permalink:  GET  /{post-id}?fields=permalink_url

import { META_GRAPH_BASE } from "../../meta.constants.js";

const GRAPH_BASE = META_GRAPH_BASE;
const FB_CAPTION_MAX = 63206;

class FacebookPublishError extends Error {
  constructor(message, { status, code, metaError } = {}) {
    super(message);
    this.name = "FacebookPublishError";
    this.status = status ?? 502;
    this.code = code ?? "FACEBOOK_PUBLISH_FAILED";
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

async function metaCall(url, params, method = "POST") {
  const res = await fetch(url, {
    method,
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new FacebookPublishError(
      body?.error?.message ?? `Facebook call failed with ${res.status}`,
      { status: res.status, metaError: body?.error ?? body }
    );
  }
  return body;
}

export const facebookAdapter = {
  channel: "FACEBOOK",

  async validatePublishTarget({ draft }) {
    const caption = buildCaption(draft);
    if (caption.length > FB_CAPTION_MAX) {
      throw new FacebookPublishError(
        `Facebook caption exceeds ${FB_CAPTION_MAX} characters (${caption.length})`,
        { status: 400, code: "PUBLISH_FAILED_CAPTION_TOO_LONG" }
      );
    }
    return { caption, mediaUrl: draft.mediaUrl ?? null };
  },

  async publishPost({ draft, connection, client }) {
    const { caption, mediaUrl } = await this.validatePublishTarget({
      draft,
      client,
    });
    const pageId = connection.externalAccountId;
    const token = connection.accessToken;
    if (!pageId) {
      throw new FacebookPublishError(
        "Connection is missing a Facebook Page ID",
        { status: 500, code: "FACEBOOK_CONNECTION_INVALID" }
      );
    }

    let postResult;
    const isVideo = draft.mediaType === "video";

    if (mediaUrl && isVideo) {
      // Video post
      postResult = await metaCall(`${GRAPH_BASE}/${pageId}/videos`, {
        file_url: mediaUrl,
        description: caption,
        access_token: token,
      });
    } else if (mediaUrl) {
      // Photo post
      postResult = await metaCall(`${GRAPH_BASE}/${pageId}/photos`, {
        url: mediaUrl,
        caption,
        access_token: token,
      });
    } else {
      // Text-only post
      postResult = await metaCall(`${GRAPH_BASE}/${pageId}/feed`, {
        message: caption,
        access_token: token,
      });
    }

    const externalPostId = postResult?.id ?? postResult?.post_id;
    if (!externalPostId) {
      throw new FacebookPublishError(
        "Facebook publish response missing post ID",
        { metaError: postResult }
      );
    }

    // Resolve permalink (non-fatal)
    let externalPostUrl = null;
    try {
      const metaRes = await fetch(
        `${GRAPH_BASE}/${externalPostId}?fields=permalink_url&access_token=${encodeURIComponent(token)}`
      );
      const metaBody = await metaRes.json().catch(() => ({}));
      if (metaRes.ok && metaBody?.permalink_url) {
        externalPostUrl = metaBody.permalink_url;
      }
    } catch {
      // non-fatal
    }

    return { externalPostId, externalPostUrl };
  },
};

export { FacebookPublishError };
