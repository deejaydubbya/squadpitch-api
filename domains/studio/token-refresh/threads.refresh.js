// Threads (Meta) token refresh adapter.
//
// Threads issues a 60-day long-lived token. Unlike OAuth 2.0 refresh
// tokens, Threads doesn't return a separate refresh_token — instead
// the *current* long-lived access token is exchanged for a fresh
// 60-day token via /refresh_access_token. This means we MUST refresh
// before the token expires; if it has already expired the user must
// reconnect.
//
// Endpoint:
//   GET https://graph.threads.net/refresh_access_token
//       ?grant_type=th_refresh_token&access_token=<current>
//
// Spec: https://developers.facebook.com/docs/threads/get-started/long-lived-tokens

import { THREADS_GRAPH_HOST } from "../threads.constants.js";

export const threadsRefresh = {
  async refresh(connection) {
    if (!connection?.accessToken) {
      return { canRefresh: false };
    }

    const url =
      `${THREADS_GRAPH_HOST}/refresh_access_token` +
      `?grant_type=th_refresh_token` +
      `&access_token=${encodeURIComponent(connection.accessToken)}`;

    const resp = await fetch(url, { method: "GET" });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // 4xx with an OAuthException usually means the token has been
      // revoked, expired beyond the refresh window, or had its scope
      // removed by the user. None of those are recoverable without a
      // reconnect — surface as canRefresh=false so the connection is
      // marked NEEDS_RECONNECT instead of crashing the caller.
      const code = data?.error?.code;
      const message = data?.error?.message ?? `Threads refresh failed (${resp.status})`;
      if (resp.status >= 400 && resp.status < 500) {
        return { canRefresh: false, error: message, providerCode: code ?? null };
      }
      throw Object.assign(new Error(message), { status: resp.status });
    }

    const newToken = data?.access_token;
    if (!newToken) {
      return { canRefresh: false, error: "Threads refresh did not return access_token" };
    }
    const expiresInSec = Number(data.expires_in) || 60 * 24 * 60 * 60;

    return {
      accessToken: newToken,
      refreshToken: null, // Threads has no separate refresh token
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  },
};
