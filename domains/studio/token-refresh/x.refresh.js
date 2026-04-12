// X (Twitter) token refresh adapter.
// X access tokens expire after ~2 hours.
// X rotates refresh tokens — each refresh returns a new one.

import { env } from "../../../config/env.js";

export const xRefresh = {
  async refresh(connection) {
    if (!connection.refreshToken) {
      return { canRefresh: false };
    }

    const credentials = Buffer.from(
      `${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`
    ).toString("base64");

    const resp = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken,
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const error = data?.error;
      if (error === "invalid_grant" || error === "invalid_request") {
        return { canRefresh: false, error: data?.error_description ?? error };
      }
      throw new Error(data?.error_description ?? "X token refresh failed");
    }

    const expiresIn = Number(data.expires_in) || 7200;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token, // X rotates refresh tokens
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  },
};
