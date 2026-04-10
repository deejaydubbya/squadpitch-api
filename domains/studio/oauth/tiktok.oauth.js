// TikTok OAuth 2.0 flow.
//
// Auth URL: https://www.tiktok.com/v2/auth/authorize/
// Token exchange: POST https://open.tiktokapis.com/v2/oauth/token/
// User info: GET https://open.tiktokapis.com/v2/user/info/

import { env } from "../../../config/env.js";

const TIKTOK_SCOPES = ["user.info.basic", "video.publish"];

function assertConfigured() {
  if (
    !env.TIKTOK_CLIENT_KEY ||
    !env.TIKTOK_CLIENT_SECRET ||
    !env.TIKTOK_REDIRECT_URI
  ) {
    throw Object.assign(new Error("TikTok credentials not configured"), {
      status: 500,
      code: "TIKTOK_NOT_CONFIGURED",
    });
  }
}

function tiktokError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "TIKTOK_OAUTH_FAILED",
    tiktokError: body,
  });
}

/**
 * Build the TikTok authorization URL.
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    redirect_uri: env.TIKTOK_REDIRECT_URI,
    state,
    scope: TIKTOK_SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

/**
 * Exchange the authorization code for a TikTok access token.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. Exchange code for tokens
  const tokenRes = await fetch(
    "https://open.tiktokapis.com/v2/oauth/token/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: env.TIKTOK_REDIRECT_URI,
      }),
    }
  );
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error) {
    throw tiktokError(
      tokenBody?.error_description ?? `TikTok token exchange failed with ${tokenRes.status}`,
      tokenBody,
      tokenRes.status
    );
  }

  const accessToken = tokenBody.access_token;
  const refreshToken = tokenBody.refresh_token ?? null;
  const openId = tokenBody.open_id;
  const expiresIn = Number(tokenBody.expires_in) || 86400;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  if (!accessToken) {
    throw tiktokError("Missing access_token in TikTok response", tokenBody);
  }

  // 2. Fetch user info for display name
  let displayName = openId ?? null;
  try {
    const userRes = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=display_name,avatar_url",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const userBody = await userRes.json().catch(() => ({}));
    if (userRes.ok && userBody?.data?.user?.display_name) {
      displayName = `@${userBody.data.user.display_name}`;
    }
  } catch {
    // non-fatal — openId is still a valid identifier
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes: TIKTOK_SCOPES,
    externalAccountId: openId,
    displayName,
  };
}
