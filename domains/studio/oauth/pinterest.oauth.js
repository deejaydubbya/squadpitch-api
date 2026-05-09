// Pinterest OAuth 2.0 — API v5.
//
// Auth URL: https://www.pinterest.com/oauth/
// Token:    POST https://api.pinterest.com/v5/oauth/token  (Basic auth)
// User:     GET  https://api.pinterest.com/v5/user_account
//
// Scope policy: Pinterest gates by exact-match scope. We request the
// minimum needed for the implemented feature set:
//   user_accounts:read   identify the connected Pinterest user
//   boards:read          let the user pick a board
//   pins:read            confirm Pin status post-publish
//   pins:write           publish Pins
// boards:write is intentionally NOT requested — Squadpitch does not
// create boards from inside the app today. Add it to the scope set
// here if/when board creation becomes a feature.

import { env } from "../../../config/env.js";

const PINTEREST_SCOPES = [
  "user_accounts:read",
  "boards:read",
  "pins:read",
  "pins:write",
];

const TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
const USER_URL = "https://api.pinterest.com/v5/user_account";

function assertConfigured() {
  if (
    !env.PINTEREST_CLIENT_ID ||
    !env.PINTEREST_CLIENT_SECRET ||
    !env.PINTEREST_REDIRECT_URI
  ) {
    throw Object.assign(
      new Error(
        "Pinterest OAuth not configured. Set PINTEREST_CLIENT_ID / " +
          "PINTEREST_CLIENT_SECRET / PINTEREST_REDIRECT_URI."
      ),
      { status: 500, code: "PINTEREST_NOT_CONFIGURED" }
    );
  }
}

function pinterestError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "PINTEREST_OAUTH_FAILED",
    pinterestError: body,
  });
}

/** Build the Pinterest authorization URL. */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.PINTEREST_CLIENT_ID,
    redirect_uri: env.PINTEREST_REDIRECT_URI,
    state,
    // Pinterest expects scopes comma-separated in the auth URL.
    scope: PINTEREST_SCOPES.join(","),
  });
  return `https://www.pinterest.com/oauth/?${params.toString()}`;
}

/**
 * Exchange the authorization code for an access token.
 *
 * Pinterest /v5/oauth/token uses HTTP Basic auth with the app's
 * client_id:client_secret as the Authorization header — distinct from
 * the form-encoded client_id/client_secret pattern used by Meta /
 * LinkedIn / TikTok. Easy to miss; getting it wrong returns
 * { code: 1, message: "Authentication failed." } which looks like a
 * scope or redirect issue but is actually the missing Basic header.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  const basic = Buffer.from(
    `${env.PINTEREST_CLIENT_ID}:${env.PINTEREST_CLIENT_SECRET}`
  ).toString("base64");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.PINTEREST_REDIRECT_URI,
    }),
  });

  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error || !tokenBody.access_token) {
    throw pinterestError(
      tokenBody?.message ?? tokenBody?.error_description ?? `Pinterest token exchange failed (${tokenRes.status})`,
      tokenBody,
      tokenRes.status
    );
  }

  const accessToken = tokenBody.access_token;
  const refreshToken = tokenBody.refresh_token ?? null;
  // Pinterest returns expires_in in seconds (default 30 days for
  // access token). Refresh tokens last ~1 year per current docs.
  const expiresIn = Number(tokenBody.expires_in) || 30 * 24 * 60 * 60;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
  const grantedScopes = tokenBody.scope
    ? String(tokenBody.scope).split(",").map((s) => s.trim()).filter(Boolean)
    : PINTEREST_SCOPES;

  // Identify the connecting account. Non-fatal — the connection still
  // works for publishing if user lookup fails.
  let externalAccountId = null;
  let displayName = null;
  try {
    const userRes = await fetch(USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userBody = await userRes.json().catch(() => ({}));
    if (userRes.ok) {
      // /v5/user_account returns { username, account_type, profile_image, … }.
      // No stable numeric "id" is exposed via this endpoint — username
      // is the canonical identifier in the v5 API.
      externalAccountId = userBody.username ?? null;
      displayName = userBody.username ? `@${userBody.username}` : null;
    }
  } catch {
    // ignore — connection is still usable.
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes: grantedScopes,
    externalAccountId,
    displayName,
  };
}
