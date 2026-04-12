// YouTube (Google) token refresh adapter.
// Google access tokens expire after 1 hour.
// Google does NOT rotate refresh tokens — the original refresh token stays valid.

import { env } from "../../../config/env.js";

export const youtubeRefresh = {
  async refresh(connection) {
    if (!connection.refreshToken) {
      return { canRefresh: false };
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
      const error = data?.error;
      // Permanent failures — user must re-authenticate
      if (error === "invalid_grant" || error === "unauthorized_client") {
        return { canRefresh: false, error: data?.error_description ?? error };
      }
      throw new Error(data?.error_description ?? "YouTube token refresh failed");
    }

    const expiresIn = Number(data.expires_in) || 3600;

    return {
      accessToken: data.access_token,
      refreshToken: connection.refreshToken, // Google doesn't rotate
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  },
};
