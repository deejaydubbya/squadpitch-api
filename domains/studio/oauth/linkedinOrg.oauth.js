// LinkedIn Organization Page OAuth 2.0 flow.
//
// Distinct from linkedin.oauth.js (personal profile) because LinkedIn
// requires the Community Management API product on a dedicated
// developer app, with a separate client_id / secret / redirect_uri.
// The auth + token endpoints are identical to the personal flow; only
// the credentials and scope set differ.
//
// Auth URL: https://www.linkedin.com/oauth/v2/authorization
// Token:    POST https://www.linkedin.com/oauth/v2/accessToken
// User:     GET  https://api.linkedin.com/v2/userinfo (OpenID Connect)
//
// Scopes default to the documented Community Management API set:
//   r_organization_admin   — list orgs the member can administer
//   w_organization_social  — write posts as the org
//   r_organization_social  — read engagement / status as the org
// Override via env LINKEDIN_ORG_SCOPES if your audit landed a
// different set.

import { env } from "../../../config/env.js";

function assertConfigured() {
  if (
    !env.LINKEDIN_ORG_CLIENT_ID ||
    !env.LINKEDIN_ORG_CLIENT_SECRET ||
    !env.LINKEDIN_ORG_REDIRECT_URI
  ) {
    throw Object.assign(
      new Error(
        "LinkedIn Organization Page (Community Management API) OAuth not configured. " +
          "Set LINKEDIN_ORG_CLIENT_ID / LINKEDIN_ORG_CLIENT_SECRET / LINKEDIN_ORG_REDIRECT_URI."
      ),
      { status: 500, code: "LINKEDIN_ORG_NOT_CONFIGURED" }
    );
  }
}

function linkedinOrgError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "LINKEDIN_ORG_OAUTH_FAILED",
    linkedinError: body,
  });
}

function getScopes() {
  return (env.LINKEDIN_ORG_SCOPES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build the LinkedIn authorization URL for the org-page app. */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINKEDIN_ORG_CLIENT_ID,
    redirect_uri: env.LINKEDIN_ORG_REDIRECT_URI,
    state,
    scope: getScopes().join(" "),
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

/**
 * Exchange the authorization code for an Organization-Page access token.
 *
 * Returns:
 *   - accessToken                    — bearer for org-API calls
 *   - tokenExpiresAt
 *   - scopes
 *   - externalAccountId  = <member-sub>:<organization-urn>
 *     We don't yet know which org the user wants to connect at this
 *     point — the caller fetches the manageable orgs from
 *     /linkedinOrgPages and prompts a picker. The chosen org id is
 *     stored on the connection in a follow-up update step.
 *   - displayName        = the LinkedIn member's display name
 *
 * Surfaces the canonical product-not-approved error path with a
 * non-technical user message:
 *   "LinkedIn Organization Page access is not approved yet."
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  const tokenRes = await fetch(
    "https://www.linkedin.com/oauth/v2/accessToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: env.LINKEDIN_ORG_CLIENT_ID,
        client_secret: env.LINKEDIN_ORG_CLIENT_SECRET,
        redirect_uri: env.LINKEDIN_ORG_REDIRECT_URI,
      }),
    }
  );

  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error) {
    // Most LinkedIn 4xx OAuth errors fall here. Detect the
    // product-approval cases so the UI can render a friendlier
    // message instead of leaking LinkedIn's internal copy.
    const code = tokenBody?.error;
    if (
      code === "unauthorized_scope_error" ||
      code === "access_denied" ||
      code === "redirect_uri_mismatch"
    ) {
      throw linkedinOrgError(
        "LinkedIn Organization Page access is not approved yet. " +
          "Please complete LinkedIn Community Management API approval, " +
          "then reconnect.",
        tokenBody,
        tokenRes.status
      );
    }
    throw linkedinOrgError(
      tokenBody?.error_description ?? `LinkedIn org token exchange failed (${tokenRes.status})`,
      tokenBody,
      tokenRes.status
    );
  }

  const accessToken = tokenBody.access_token;
  // LinkedIn's OAuth lifetime — usually 60 days for member-bound tokens.
  const expiresIn = Number(tokenBody.expires_in) || 60 * 24 * 60 * 60;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  if (!accessToken) {
    throw linkedinOrgError("Missing access_token in LinkedIn org response", tokenBody);
  }

  // Identify the connecting member via the standard userinfo endpoint
  // — this works under either OpenID-Connect or org-admin scopes if
  // the app has Sign In configured. Non-fatal if it 403s; we just
  // skip the displayName / externalAccountId.
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
    // ignore — the connection is still usable for org-context calls.
  }

  return {
    accessToken,
    refreshToken: null,
    tokenExpiresAt,
    scopes: getScopes(),
    // Stored as the member sub for now — overwritten with the
    // organization URN once the user picks a page from the picker.
    // See linkedinOrgPages.service.js for that follow-up step.
    externalAccountId: sub,
    displayName,
  };
}
