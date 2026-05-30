// Instagram (Instagram Login / Business Login) token refresh adapter.
//
// The Instagram API issues a 60-day long-lived user token. There is
// no separate refresh_token — instead the CURRENT long-lived token
// is exchanged for a fresh 60-day token via /refresh_access_token.
// Means we MUST refresh before the token expires; if it has already
// expired the user has to reconnect through Instagram Business Login.
//
// Endpoint:
//   GET https://graph.instagram.com/refresh_access_token
//       ?grant_type=ig_refresh_token&access_token=<current>
//
// Spec: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#refresh-token
//
// IMPORTANT: this is intentionally a SEPARATE adapter from
// meta.refresh.js. The Facebook channel still uses meta.refresh
// (Page tokens, fb_exchange_token via graph.facebook.com), but
// the Instagram channel after the Business Login migration
// (Prompt 01) uses its own host + grant type. See
// instagram.oauth.js for the file-header explanation.

const INSTAGRAM_GRAPH_HOST = "https://graph.instagram.com";

export const instagramRefresh = {
  async refresh(connection) {
    if (!connection?.accessToken) {
      return { canRefresh: false };
    }

    const url =
      `${INSTAGRAM_GRAPH_HOST}/refresh_access_token`
      + `?grant_type=ig_refresh_token`
      + `&access_token=${encodeURIComponent(connection.accessToken)}`;

    const resp = await fetch(url, { method: "GET" });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const code = data?.error?.code;
      const message =
        data?.error?.message
        ?? data?.error_message
        ?? `Instagram refresh failed (${resp.status})`;
      // 429 is rate-limit, not a permission problem — treat as
      // transient so the refresh job retries via its usual
      // backoff instead of marking the connection NEEDS_RECONNECT.
      if (resp.status === 429 || resp.status >= 500) {
        throw Object.assign(new Error(message), { status: resp.status });
      }
      // Other 4xx (400/401/403/etc.) usually means the token has
      // been revoked, expired beyond the refresh window, or had
      // its scope removed by the user. None of those are
      // recoverable without a reconnect — surface as
      // canRefresh:false so the connection is marked
      // NEEDS_RECONNECT instead of crashing the caller.
      if (resp.status >= 400 && resp.status < 500) {
        return { canRefresh: false, error: message, providerCode: code ?? null };
      }
      throw Object.assign(new Error(message), { status: resp.status });
    }

    const newToken = data?.access_token;
    if (!newToken) {
      return {
        canRefresh: false,
        error: "Instagram refresh did not return access_token",
      };
    }
    // expires_in is seconds. Per the docs the long-lived token
    // currently lasts 60 days; default to that if Meta omits the
    // field. They reserve the right to change the duration so we
    // always prefer the value they actually return.
    const expiresInSec = Number(data.expires_in) || 60 * 24 * 60 * 60;

    return {
      accessToken: newToken,
      refreshToken: null, // Instagram has no separate refresh token
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  },
};
