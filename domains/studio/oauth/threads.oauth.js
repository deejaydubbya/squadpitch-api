// Threads (Meta) OAuth flow.
//
// Distinct from the Facebook/Instagram flow in instagram.oauth.js:
//   - separate Meta app (own client_id / client_secret / redirect_uri)
//   - authorization hosted at threads.net (consumer host)
//   - token exchange + data calls on graph.threads.net
//   - uses Threads-specific scopes (threads_basic, threads_content_publish, ...)
//   - issues a 60-day long-lived token; refreshable via /refresh_access_token
//
// Two-step token exchange:
//   1. POST /oauth/access_token       → short-lived 1h token
//   2. GET  /access_token (th_exchange_token) → long-lived 60d token
//
// The long-lived token is what we store. After 60 days the refresh
// adapter (token-refresh/threads.refresh.js) calls
// /refresh_access_token to roll forward.
//
// Spec: https://developers.facebook.com/docs/threads/get-started/

import { env } from "../../../config/env.js";
import {
  THREADS_AUTH_HOST,
  THREADS_GRAPH_HOST,
  THREADS_GRAPH_BASE,
  THREADS_SCOPES,
} from "../threads.constants.js";

function assertConfigured() {
  if (!env.THREADS_ENABLED) {
    throw Object.assign(new Error("Threads channel is disabled"), {
      status: 503,
      code: "THREADS_DISABLED",
    });
  }
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET || !env.THREADS_REDIRECT_URI) {
    throw Object.assign(new Error("Threads app credentials not configured"), {
      status: 500,
      code: "THREADS_NOT_CONFIGURED",
    });
  }
}

function threadsError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "THREADS_OAUTH_FAILED",
    threadsError: body,
  });
}

// graph.threads.net wants form-encoded for POST and query-string for
// GET. We never include the access_token in returned error bodies —
// they're echoed in logs by the caller's error handler.
async function threadsRequest({ method, path, query, form, host = THREADS_GRAPH_HOST }) {
  const url = new URL(`${host}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null) url.searchParams.set(k, v);
  }
  const init = { method };
  if (form) {
    init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    init.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url.toString(), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw threadsError(
      body?.error?.message ?? `Threads ${path} failed with ${res.status}`,
      body,
      res.status
    );
  }
  return body;
}

// Build the /oauth/authorize URL the user is redirected to.
//
// `scope` must be space-separated (Meta's Threads docs differ from FB
// here: FB uses comma-separated scopes, Threads expects spaces).
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.THREADS_APP_ID,
    redirect_uri: env.THREADS_REDIRECT_URI,
    state,
    scope: THREADS_SCOPES.join(","),
    response_type: "code",
  });
  return `${THREADS_AUTH_HOST}/oauth/authorize?${params.toString()}`;
}

// Exchange the OAuth `code` for a long-lived 60-day token, then fetch
// the user identity. Returns the normalized shape upsertConnection
// expects.
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. code → short-lived (1h) token
  const shortRes = await threadsRequest({
    method: "POST",
    path: "/oauth/access_token",
    form: {
      client_id: env.THREADS_APP_ID,
      client_secret: env.THREADS_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: env.THREADS_REDIRECT_URI,
      code,
    },
  });
  const shortToken = shortRes?.access_token;
  if (!shortToken) {
    throw threadsError("Threads short-lived token missing in response", shortRes);
  }

  // 2. short-lived → long-lived (60d) token
  const longRes = await threadsRequest({
    method: "GET",
    path: "/access_token",
    query: {
      grant_type: "th_exchange_token",
      client_secret: env.THREADS_APP_SECRET,
      access_token: shortToken,
    },
  });
  const longToken = longRes?.access_token;
  if (!longToken) {
    throw threadsError("Threads long-lived token missing in response", longRes);
  }
  const expiresInSec = Number(longRes.expires_in) || 60 * 24 * 60 * 60; // fallback 60d
  const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

  // 3. fetch user identity for displayName + externalAccountId
  const me = await threadsRequest({
    method: "GET",
    path: "/me",
    query: {
      fields: "id,username,threads_profile_picture_url",
      access_token: longToken,
    },
    host: THREADS_GRAPH_BASE.startsWith(THREADS_GRAPH_HOST)
      ? THREADS_GRAPH_HOST
      : THREADS_GRAPH_HOST,
  }).catch(async () => {
    // /me without an explicit version path works on graph.threads.net;
    // if Meta later requires the version segment, retry against the
    // versioned base.
    return threadsRequest({
      method: "GET",
      path: "/me",
      query: {
        fields: "id,username,threads_profile_picture_url",
        access_token: longToken,
      },
      host: THREADS_GRAPH_BASE,
    });
  });

  const userId = me?.id;
  const username = me?.username ?? null;
  if (!userId) {
    throw threadsError("Threads /me did not return a user id", me);
  }

  return {
    accessToken: longToken,
    refreshToken: null, // Threads uses self-refresh of the long-lived token
    tokenExpiresAt,
    scopes: THREADS_SCOPES,
    externalAccountId: String(userId),
    displayName: username ? `@${username}` : null,
  };
}
