// YouTube (Google OAuth 2.0) flow.
//
// Auth URL: https://accounts.google.com/o/oauth2/v2/auth
// Token: POST https://oauth2.googleapis.com/token
// Channel info: GET https://www.googleapis.com/youtube/v3/channels?mine=true
//
// We request offline access to get a refresh token, since Google access
// tokens expire after 1 hour. The refresh token allows us to publish
// videos without re-authenticating.

import { env } from "../../../config/env.js";

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

function assertConfigured() {
  if (
    !env.YOUTUBE_CLIENT_ID ||
    !env.YOUTUBE_CLIENT_SECRET ||
    !env.YOUTUBE_REDIRECT_URI
  ) {
    throw Object.assign(new Error("YouTube credentials not configured"), {
      status: 500,
      code: "YOUTUBE_NOT_CONFIGURED",
    });
  }
}

function youtubeError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "YOUTUBE_OAUTH_FAILED",
    youtubeError: body,
  });
}

/**
 * Build the Google OAuth authorization URL for YouTube access.
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    redirect_uri: env.YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange the authorization code for a YouTube access token.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      redirect_uri: env.YOUTUBE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error) {
    throw youtubeError(
      tokenBody?.error_description ?? `YouTube token exchange failed with ${tokenRes.status}`,
      tokenBody,
      tokenRes.status
    );
  }

  const accessToken = tokenBody.access_token;
  const refreshToken = tokenBody.refresh_token ?? null;
  const expiresIn = Number(tokenBody.expires_in) || 3600;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  if (!accessToken) {
    throw youtubeError("Missing access_token in YouTube response", tokenBody);
  }

  // 2. Get channel info for display name and channel ID
  let channelId = null;
  let displayName = null;
  try {
    const channelRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const channelBody = await channelRes.json().catch(() => ({}));
    if (channelRes.ok && channelBody?.items?.length > 0) {
      const ch = channelBody.items[0];
      channelId = ch.id;
      displayName = ch.snippet?.title ?? null;
    }
  } catch {
    // non-fatal
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes: YOUTUBE_SCOPES,
    externalAccountId: channelId,
    displayName,
  };
}
