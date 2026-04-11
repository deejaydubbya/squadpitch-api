// YouTube Data API v3 publishing adapter.
//
// Video upload: resumable upload to
//   POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable
// then PUT the video bytes to the returned Location header.
//
// YouTube only supports video uploads via the API — text-only or image-only
// posts are not possible, so we reject those early in validation.
//
// Google access tokens expire after 1 hour, so we auto-refresh using the
// stored refresh token before each publish attempt.

import { env } from "../../../../config/env.js";
import { prisma } from "../../../../prisma.js";
import { encryptToken } from "../../../../lib/tokenCrypto.js";

const YT_TITLE_MAX = 100;
const YT_DESCRIPTION_MAX = 5000;

class YouTubePublishError extends Error {
  constructor(message, { status, code, youtubeError } = {}) {
    super(message);
    this.name = "YouTubePublishError";
    this.status = status ?? 502;
    this.code = code ?? "YOUTUBE_PUBLISH_FAILED";
    this.youtubeError = youtubeError ?? null;
  }
}

/**
 * Refresh a Google access token using the stored refresh token.
 * Updates the encrypted token in DB and returns the new plaintext access token.
 */
async function ensureFreshToken(connection) {
  // If token is still valid (with 60s buffer), use it as-is
  if (
    connection.tokenExpiresAt &&
    new Date(connection.tokenExpiresAt) > new Date(Date.now() + 60_000)
  ) {
    return connection.accessToken;
  }

  if (!connection.refreshToken) {
    throw new YouTubePublishError(
      "YouTube connection has no refresh token — user must re-authenticate",
      { status: 401, code: "YOUTUBE_NO_REFRESH_TOKEN" }
    );
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new YouTubePublishError(
      data?.error_description ?? "YouTube token refresh failed",
      { status: 401, code: "YOUTUBE_TOKEN_REFRESH_FAILED", youtubeError: data }
    );
  }

  const newAccessToken = data.access_token;
  const expiresIn = Number(data.expires_in) || 3600;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  // Persist refreshed token (encrypted)
  await prisma.channelConnection.updateMany({
    where: { id: connection.id },
    data: {
      accessToken: encryptToken(newAccessToken),
      tokenExpiresAt,
    },
  });

  return newAccessToken;
}

/**
 * Build YouTube video metadata from a draft.
 */
function buildVideoMeta(draft) {
  const body = draft.body ?? "";
  const tags = Array.isArray(draft.hashtags) ? draft.hashtags : [];

  // Title: first line of body, truncated to 100 chars
  const firstLine = body.split("\n")[0] || "Untitled";
  const title =
    firstLine.length > YT_TITLE_MAX
      ? firstLine.slice(0, YT_TITLE_MAX - 1) + "…"
      : firstLine;

  // Description: full body + hashtags
  const cleanTags = tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
  const tagLine = cleanTags.join(" ");
  let description = body;
  if (tagLine) description += `\n\n${tagLine}`;
  if (description.length > YT_DESCRIPTION_MAX) {
    description = description.slice(0, YT_DESCRIPTION_MAX);
  }

  // YouTube tags (without # prefix, max 500 chars total)
  const ytTags = tags.map((t) => t.replace(/^#/, ""));

  return { title, description, tags: ytTags };
}

export const youtubeAdapter = {
  channel: "YOUTUBE",

  async validatePublishTarget({ draft }) {
    if (!draft.mediaUrl) {
      throw new YouTubePublishError(
        "YouTube requires a video. Set draft.mediaUrl to a video file.",
        { status: 400, code: "PUBLISH_FAILED_NO_VIDEO" }
      );
    }

    if (draft.mediaType && draft.mediaType !== "video") {
      throw new YouTubePublishError(
        "YouTube only supports video uploads. The draft media type must be video.",
        { status: 400, code: "PUBLISH_FAILED_NOT_VIDEO" }
      );
    }

    const meta = buildVideoMeta(draft);
    return { mediaUrl: draft.mediaUrl, ...meta };
  },

  async publishPost({ draft, connection }) {
    const { mediaUrl, title, description, tags } =
      await this.validatePublishTarget({ draft });

    const channelId = connection.externalAccountId;
    if (!channelId) {
      throw new YouTubePublishError(
        "Connection is missing a YouTube channel ID",
        { status: 500, code: "YOUTUBE_CONNECTION_INVALID" }
      );
    }

    // Refresh token if needed
    const accessToken = await ensureFreshToken(connection);

    // 1. Fetch the video binary
    const videoRes = await fetch(mediaUrl);
    if (!videoRes.ok) {
      throw new YouTubePublishError(
        `Failed to fetch video from ${mediaUrl}: ${videoRes.status}`,
        { status: 502 }
      );
    }
    const videoBuffer = await videoRes.arrayBuffer();
    const contentType =
      videoRes.headers.get("content-type") || "video/mp4";

    // 2. Initiate resumable upload
    const snippet = { title, description, tags, categoryId: "22" };
    const status = { privacyStatus: "public" };

    const initRes = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(videoBuffer.byteLength),
          "X-Upload-Content-Type": contentType,
        },
        body: JSON.stringify({ snippet, status }),
      }
    );

    if (!initRes.ok) {
      const errBody = await initRes.json().catch(() => ({}));
      throw new YouTubePublishError(
        errBody?.error?.message ??
          `YouTube resumable upload init failed with ${initRes.status}`,
        { status: initRes.status, youtubeError: errBody }
      );
    }

    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) {
      throw new YouTubePublishError(
        "YouTube resumable upload init missing Location header"
      );
    }

    // 3. Upload the video bytes
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(videoBuffer.byteLength),
      },
      body: videoBuffer,
    });

    const uploadBody = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok) {
      throw new YouTubePublishError(
        uploadBody?.error?.message ??
          `YouTube video upload failed with ${uploadRes.status}`,
        { status: uploadRes.status, youtubeError: uploadBody }
      );
    }

    const videoId = uploadBody.id;
    if (!videoId) {
      throw new YouTubePublishError(
        "YouTube upload response missing video id",
        { youtubeError: uploadBody }
      );
    }

    return {
      externalPostId: videoId,
      externalPostUrl: `https://youtube.com/watch?v=${videoId}`,
    };
  },
};

export { YouTubePublishError };
