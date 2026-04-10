// X (Twitter) OAuth 2.0 with PKCE flow.
//
// Auth URL: https://x.com/i/oauth2/authorize
// Token: POST https://api.x.com/2/oauth2/token
// User info: GET https://api.x.com/2/users/me
//
// X requires PKCE (Proof Key for Code Exchange). The code_verifier is stored
// in Redis alongside the nonce from oauthStateCodec so it can be retrieved
// during the token exchange step.

import crypto from "node:crypto";
import { env } from "../../../config/env.js";
import { redisSet, redisGet, redisDel } from "../../../redis.js";

const X_SCOPES = ["tweet.write", "tweet.read", "users.read", "offline.access"];
const PKCE_KEY_PREFIX = "sp:oauth:pkce:";
const PKCE_TTL_SECONDS = 10 * 60; // 10 minutes, matches state TTL

function assertConfigured() {
  if (
    !env.X_CLIENT_ID ||
    !env.X_CLIENT_SECRET ||
    !env.X_REDIRECT_URI
  ) {
    throw Object.assign(new Error("X (Twitter) credentials not configured"), {
      status: 500,
      code: "X_NOT_CONFIGURED",
    });
  }
}

function xError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "X_OAUTH_FAILED",
    xError: body,
  });
}

/**
 * Generate PKCE code_verifier and code_challenge (S256).
 */
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/**
 * Build the X authorization URL. Stores the PKCE code_verifier in Redis
 * keyed by the state token so it can be retrieved during exchangeCode().
 */
export async function buildAuthUrl({ state }) {
  assertConfigured();

  const { verifier, challenge } = generatePKCE();

  // Store verifier in Redis so exchangeCode() can retrieve it
  await redisSet(
    `${PKCE_KEY_PREFIX}${state}`,
    verifier,
    PKCE_TTL_SECONDS
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: env.X_REDIRECT_URI,
    scope: X_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://x.com/i/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange the authorization code for an X access token.
 * Retrieves the PKCE code_verifier from Redis using the state token.
 */
export async function exchangeCode({ code, state }) {
  assertConfigured();

  // Retrieve PKCE verifier
  const pkceKey = `${PKCE_KEY_PREFIX}${state}`;
  const codeVerifier = await redisGet(pkceKey);
  if (!codeVerifier) {
    throw xError("PKCE code_verifier not found — state may have expired", null, 400);
  }
  await redisDel(pkceKey);

  // Exchange code for tokens
  const basicAuth = Buffer.from(
    `${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`
  ).toString("base64");

  const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: env.X_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error) {
    throw xError(
      tokenBody?.error_description ?? `X token exchange failed with ${tokenRes.status}`,
      tokenBody,
      tokenRes.status
    );
  }

  const accessToken = tokenBody.access_token;
  const refreshToken = tokenBody.refresh_token ?? null;
  const expiresIn = Number(tokenBody.expires_in) || 7200; // X default is 2h
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  if (!accessToken) {
    throw xError("Missing access_token in X response", tokenBody);
  }

  // Get user info for display name and user ID
  let userId = null;
  let displayName = null;
  let username = null;
  try {
    const userRes = await fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userBody = await userRes.json().catch(() => ({}));
    if (userRes.ok && userBody?.data) {
      userId = userBody.data.id;
      username = userBody.data.username;
      displayName = username ? `@${username}` : userBody.data.name;
    }
  } catch {
    // non-fatal
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes: X_SCOPES,
    externalAccountId: userId,
    displayName,
    _username: username, // passed through for post URL construction
  };
}
