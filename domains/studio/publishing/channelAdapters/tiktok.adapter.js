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

// TikTok's PULL_FROM_URL flow only accepts hosts that are verified in
// the TikTok developer portal. squadpitch.com is verified;
// res.cloudinary.com is not (and can't be, since it isn't our domain).
// The web app exposes a scoped /media-proxy/ route that streams from
// our Cloudinary cloud while serving from squadpitch.com — see
// squadpitch-web/src/app/media-proxy/[...path]/route.ts. We rewrite
// any Cloudinary URL to point at the proxy before handing it to TikTok.
//
//   https://res.cloudinary.com/<cloud>/<path...>
//     →  https://squadpitch.com/media-proxy/<path...>
function rewriteToVerifiedHost(mediaUrl) {
  if (!mediaUrl || typeof mediaUrl !== "string") return mediaUrl;
  const m = mediaUrl.match(/^https?:\/\/res\.cloudinary\.com\/[^/]+\/(.+)$/);
  if (!m) return mediaUrl;
  const base = (process.env.PUBLIC_SITE_URL || "https://squadpitch.com").replace(/\/+$/, "");
  return `${base}/media-proxy/${m[1]}`;
}

// Map of TikTok privacy values, ordered most-public → least-public.
// We pick the first one that's actually allowed for this app/user combo.
const PRIVACY_PREFERENCE = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];

// Query /creator_info/query/ to find out which privacy levels TikTok
// will accept for this token. Unaudited apps get ["SELF_ONLY"] only;
// audited apps get the full list. We try public-first and degrade.
//
// On any error (network / unexpected shape) we fall back to SELF_ONLY
// — that's the universal default and the only level that works pre-
// audit. The post will be private, but it WILL post.
async function resolvePrivacyLevel(token) {
  try {
    const res = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
      }
    );
    if (!res.ok) return "SELF_ONLY";
    const body = await res.json().catch(() => ({}));
    const allowed = body?.data?.privacy_level_options;
    if (!Array.isArray(allowed) || allowed.length === 0) return "SELF_ONLY";
    for (const candidate of PRIVACY_PREFERENCE) {
      if (allowed.includes(candidate)) return candidate;
    }
    return allowed[0];
  } catch {
    return "SELF_ONLY";
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
    const { mediaUrl: rawMediaUrl, caption } = await this.validatePublishTarget({
      draft,
      client,
    });
    const mediaUrl = rewriteToVerifiedHost(rawMediaUrl);
    const token = connection.accessToken;

    // Resolve which privacy_level TikTok will accept for THIS app/user
    // combo before posting. Unaudited apps get
    //   privacy_level_options: ["SELF_ONLY"]
    // Audited apps get the full list (PUBLIC_TO_EVERYONE,
    // MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, SELF_ONLY).
    // Sending an option not in the allow-list returns
    //   error.code: "unaudited_client_can_only_post_to_private_accounts"
    // which is fatal. Querying creator_info first means the same code
    // path works pre- and post-audit without manual flipping.
    const privacyLevel = await resolvePrivacyLevel(token);

    // TikTok exposes TWO publish endpoints — one per media type. Photo
    // and video have different request shapes and the wrong combination
    // produces "(invalid_params) Invalid media_type or post_mode":
    //
    //   VIDEO → POST /v2/post/publish/video/init/
    //     body: { post_info, source_info, post_mode }
    //     (no media_type field)
    //
    //   PHOTO → POST /v2/post/publish/content/init/
    //     body: { post_info, source_info, post_mode, media_type: "PHOTO" }
    //     source_info also needs photo_cover_index.
    //
    // Both paths use post_mode: "DIRECT_POST" — that's the Direct Post
    // flow our `video.publish` scope authorizes. The `inbox/video/init/`
    // endpoint is for the separate Upload-to-Inbox flow which we don't
    // use today (would need video.upload).
    const isVideo = draft.mediaType === "video";

    const url = isVideo
      ? "https://open.tiktokapis.com/v2/post/publish/video/init/"
      : "https://open.tiktokapis.com/v2/post/publish/content/init/";

    const postBody = isVideo
      ? {
          post_info: {
            title: caption.slice(0, 2200),
            privacy_level: privacyLevel,
            disable_comment: false,
            disable_duet: false,
            disable_stitch: false,
          },
          source_info: {
            source: "PULL_FROM_URL",
            video_url: mediaUrl,
          },
          post_mode: "DIRECT_POST",
        }
      : {
          post_info: {
            title: caption.slice(0, 2200),
            privacy_level: privacyLevel,
            disable_comment: false,
            auto_add_music: true,
          },
          source_info: {
            source: "PULL_FROM_URL",
            photo_cover_index: 0,
            photo_images: [mediaUrl],
          },
          post_mode: "DIRECT_POST",
          media_type: "PHOTO",
        };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(postBody),
    });

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
