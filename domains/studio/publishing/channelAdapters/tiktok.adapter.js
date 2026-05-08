// TikTok Content Posting API adapter.
//
// TikTok is visual-first — a media URL is required.
// Photo post: POST /v2/post/publish/content/init/
//   with media_type: PHOTO, photo_images array

class TikTokPublishError extends Error {
  constructor(message, { status, code, tiktokError } = {}) {
    super(message);
    this.name = "TikTokPublishError";
    this.status = status ?? 502;
    this.code = code ?? "TIKTOK_PUBLISH_FAILED";
    this.tiktokError = tiktokError ?? null;
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

export const tiktokAdapter = {
  channel: "TIKTOK",

  async validatePublishTarget({ draft }) {
    if (!draft.mediaUrl) {
      throw new TikTokPublishError(
        "TikTok requires a media URL. Attach an image before publishing.",
        { status: 400, code: "PUBLISH_FAILED_NO_MEDIA" }
      );
    }
    const caption = buildCaption(draft);
    return { mediaUrl: draft.mediaUrl, caption };
  },

  async publishPost({ draft, connection, client }) {
    const { mediaUrl, caption } = await this.validatePublishTarget({
      draft,
      client,
    });
    const token = connection.accessToken;

    // Determine media type (video vs photo)
    const isVideo = draft.mediaType === "video";

    // post_mode is REQUIRED on the Direct Post path. TikTok's
    // /v2/post/publish/content/init/ endpoint rejects requests
    // without it as "Invalid media_type or post_mode". Photo flow
    // additionally requires photo_cover_index (which slide is the
    // cover) — we always use the first image since we publish a
    // single photo today.
    const postBody = {
      post_mode: "DIRECT_POST",
      media_type: isVideo ? "VIDEO" : "PHOTO",
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: false,
      },
      source_info: isVideo
        ? { source: "PULL_FROM_URL", video_url: mediaUrl }
        : {
            source: "PULL_FROM_URL",
            photo_cover_index: 0,
            photo_images: [mediaUrl],
          },
    };

    const res = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/content/init/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(postBody),
      }
    );

    const body = await res.json().catch(() => ({}));

    if (!res.ok || body?.error?.code) {
      throw new TikTokPublishError(
        body?.error?.message ?? `TikTok publish failed with ${res.status}`,
        { status: res.status, tiktokError: body?.error ?? body }
      );
    }

    const publishId = body?.data?.publish_id ?? null;

    // TikTok API does not return a permalink — there is no reliable way
    // to construct one from the publish_id alone.
    return {
      externalPostId: publishId,
      externalPostUrl: null,
    };
  },
};

export { TikTokPublishError };
