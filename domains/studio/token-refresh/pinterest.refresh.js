// Pinterest continuous refresh-token adapter (API v5).
// Tokens and provider response bodies must never be logged from this module.

import { env } from "../../../config/env.js";
import { pinterestApiUrl } from "../oauth/pinterestApi.js";

const REQUEST_TIMEOUT_MS = 15_000;

function reconnect(error = "Pinterest authorization must be renewed") {
  return { canRefresh: false, code: "PINTEREST_RECONNECT_REQUIRED", error };
}

export const pinterestRefresh = {
  async refresh(connection) {
    if (!connection.refreshToken) return reconnect();
    if (
      connection.refreshTokenExpiresAt &&
      new Date(connection.refreshTokenExpiresAt) <= new Date()
    ) {
      return reconnect("Pinterest refresh token expired");
    }

    const credentials = Buffer.from(
      `${env.PINTEREST_CLIENT_ID}:${env.PINTEREST_CLIENT_SECRET}`,
    ).toString("base64");

    let response;
    try {
      response = await fetch(pinterestApiUrl("/v5/oauth/token"), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: connection.refreshToken,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw Object.assign(new Error("Pinterest token service is unavailable"), {
        status: 503,
        code: "PINTEREST_UNAVAILABLE",
        transient: true,
        cause,
      });
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const providerError = String(body?.error ?? body?.code ?? "").toLowerCase();
      if (
        response.status === 400 &&
        ["invalid_grant", "invalid_request", "2"].includes(providerError)
      ) {
        return reconnect();
      }
      if (response.status === 401 || response.status === 403) {
        return reconnect("Pinterest rejected the application credentials or authorization");
      }
      if (response.status === 429 || response.status >= 500) {
        throw Object.assign(new Error("Pinterest token service is temporarily unavailable"), {
          status: response.status === 429 ? 429 : 503,
          code: "PINTEREST_UNAVAILABLE",
          transient: true,
        });
      }
      throw Object.assign(new Error("Pinterest token refresh failed"), {
        status: 502,
        code: "PINTEREST_TOKEN_REFRESH_FAILED",
      });
    }

    const expiresIn = Number(body.expires_in) || 30 * 24 * 60 * 60;
    const refreshExpiresIn = Number(body.refresh_token_expires_in);
    const refreshExpiresAtSeconds = Number(body.refresh_token_expires_at);
    const refreshTokenExpiresAt = Number.isFinite(refreshExpiresAtSeconds) && refreshExpiresAtSeconds > 0
      ? new Date(refreshExpiresAtSeconds * 1000)
      : Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
        ? new Date(Date.now() + refreshExpiresIn * 1000)
        : connection.refreshTokenExpiresAt ?? null;

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? connection.refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      refreshTokenExpiresAt,
    };
  },
};
