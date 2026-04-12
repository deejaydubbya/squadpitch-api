// TikTok token refresh adapter.
// TikTok access tokens expire after ~24 hours.
// TikTok rotates refresh tokens — each refresh returns a new one.

import { env } from "../../../config/env.js";

export const tiktokRefresh = {
  async refresh(connection) {
    if (!connection.refreshToken) {
      return { canRefresh: false };
    }

    const resp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken,
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || data.error) {
      const error = data?.error;
      if (
        error === "invalid_grant" ||
        error === "access_token_invalid" ||
        error === "refresh_token_invalid"
      ) {
        return {
          canRefresh: false,
          error: data?.error_description ?? error,
        };
      }
      throw new Error(
        data?.error_description ?? "TikTok token refresh failed"
      );
    }

    const expiresIn = Number(data.expires_in) || 86400;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token, // TikTok rotates refresh tokens
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  },
};
