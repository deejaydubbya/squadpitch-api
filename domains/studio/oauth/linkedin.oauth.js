// LinkedIn OAuth 2.0 flow.
//
// Auth URL: https://www.linkedin.com/oauth/v2/authorization
// Token: POST https://www.linkedin.com/oauth/v2/accessToken
// User info: GET https://api.linkedin.com/v2/userinfo (OpenID Connect)

import { env } from "../../../config/env.js";

const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"];

function assertConfigured() {
  if (
    !env.LINKEDIN_CLIENT_ID ||
    !env.LINKEDIN_CLIENT_SECRET ||
    !env.LINKEDIN_REDIRECT_URI
  ) {
    throw Object.assign(new Error("LinkedIn credentials not configured"), {
      status: 500,
      code: "LINKEDIN_NOT_CONFIGURED",
    });
  }
}

function linkedinError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "LINKEDIN_OAUTH_FAILED",
    linkedinError: body,
  });
}

/**
 * Build the LinkedIn authorization URL.
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: env.LINKEDIN_REDIRECT_URI,
    state,
    scope: LINKEDIN_SCOPES.join(" "),
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

/**
 * Exchange the authorization code for a LinkedIn access token.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. Exchange code for access token
  const tokenRes = await fetch(
    "https://www.linkedin.com/oauth/v2/accessToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: env.LINKEDIN_CLIENT_ID,
        client_secret: env.LINKEDIN_CLIENT_SECRET,
        redirect_uri: env.LINKEDIN_REDIRECT_URI,
      }),
    }
  );
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error) {
    throw linkedinError(
      tokenBody?.error_description ?? `LinkedIn token exchange failed with ${tokenRes.status}`,
      tokenBody,
      tokenRes.status
    );
  }

  const accessToken = tokenBody.access_token;
  const expiresIn = Number(tokenBody.expires_in) || 60 * 24 * 60 * 60;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  if (!accessToken) {
    throw linkedinError("Missing access_token in LinkedIn response", tokenBody);
  }

  // 2. Get user info via OpenID Connect userinfo endpoint
  let sub = null;
  let displayName = null;
  try {
    const userRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userBody = await userRes.json().catch(() => ({}));
    if (userRes.ok) {
      sub = userBody.sub ?? null;
      displayName = userBody.name ?? userBody.email ?? null;
    }
  } catch {
    // non-fatal — sub can be null, connection still works
  }

  return {
    accessToken,
    refreshToken: null, // LinkedIn v2 does not issue refresh tokens by default
    tokenExpiresAt,
    scopes: LINKEDIN_SCOPES,
    externalAccountId: sub,
    displayName,
  };
}
