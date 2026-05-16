// Google Business Profile (GBP) — OAuth 2.0 flow.
//
// Auth URL:    https://accounts.google.com/o/oauth2/v2/auth
// Token URL:   POST https://oauth2.googleapis.com/token
// Accounts:    GET  https://mybusinessaccountmanagement.googleapis.com/v1/accounts
//
// Distinct from YouTube even though both are "Google OAuth". The
// business.manage scope is Google-sensitive — it has its own
// verification cycle and needs its own OAuth client + consent
// screen submission. We deliberately use SEPARATE env vars so the
// YouTube credentials can never accidentally be sent to the GBP
// auth endpoint.
//
// Post-OAuth flow:
//   1. exchange code -> access + refresh tokens (offline access)
//   2. fetch /v1/accounts -> array of business accounts the user manages
//   3. store the FIRST account's "accounts/{id}" as externalAccountId
//      (a sentinel — the location picker upgrades this to
//      "accounts/{a}/locations/{l}" before any review polling /
//      reply can fire).
//   4. ChannelConnection.displayName = account name (gets overwritten
//      by location title once the location picker runs).
//
// The "needs location picker" state is detected by the absence of
// "/locations/" in externalAccountId — same pattern as Pinterest's
// board picker.

import { env } from "../../../config/env.js";

export const GBP_SCOPES = ["https://www.googleapis.com/auth/business.manage"];

// Required Google APIs (must be enabled in the Cloud Console):
//   - mybusinessaccountmanagement.googleapis.com    (list accounts)
//   - mybusinessbusinessinformation.googleapis.com  (list locations)
//   - mybusiness.googleapis.com v4                  (list reviews + updateReply)
//
// The reviews endpoints still live on the v4 (legacy) API as of
// 2026 — Google never migrated them to a v1 surface. Account +
// location listing is on the modern v1 APIs.
export const GBP_ACCOUNT_MGMT_BASE =
  "https://mybusinessaccountmanagement.googleapis.com/v1";
export const GBP_BUSINESS_INFO_BASE =
  "https://mybusinessbusinessinformation.googleapis.com/v1";
export const GBP_V4_BASE = "https://mybusiness.googleapis.com/v4";

function assertConfigured() {
  if (
    !env.GOOGLE_BUSINESS_PROFILE_CLIENT_ID ||
    !env.GOOGLE_BUSINESS_PROFILE_CLIENT_SECRET ||
    !env.GOOGLE_BUSINESS_PROFILE_REDIRECT_URI
  ) {
    throw Object.assign(
      new Error("Google Business Profile credentials not configured"),
      { status: 500, code: "GBP_NOT_CONFIGURED" },
    );
  }
}

function gbpError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "GBP_OAUTH_FAILED",
    gbpError: body,
  });
}

/**
 * Build the Google OAuth authorization URL for GBP access.
 * access_type=offline + prompt=consent ensures a refresh token
 * is issued on every authorization (Google omits refresh tokens
 * for repeat authorizations without explicit re-consent).
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_BUSINESS_PROFILE_CLIENT_ID,
    redirect_uri: env.GOOGLE_BUSINESS_PROFILE_REDIRECT_URI,
    response_type: "code",
    scope: GBP_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange the authorization code for GBP tokens. Returns the
 * tokenBundle shape the existing connection.service expects
 * (accessToken / refreshToken / tokenExpiresAt / scopes /
 * externalAccountId / displayName).
 *
 * externalAccountId here is "accounts/{id}" — a SENTINEL value
 * that signals "OAuth done, location picker still required".
 * The polling worker + reply send service refuse to act on
 * connections whose externalAccountId does not contain
 * "/locations/" so a half-finished connection never fires.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. code -> access + refresh tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_BUSINESS_PROFILE_CLIENT_ID,
      client_secret: env.GOOGLE_BUSINESS_PROFILE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_BUSINESS_PROFILE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error) {
    throw gbpError(
      tokenBody?.error_description ?? `GBP token exchange failed with ${tokenRes.status}`,
      tokenBody,
      tokenRes.status,
    );
  }
  const accessToken = tokenBody.access_token;
  const refreshToken = tokenBody.refresh_token ?? null;
  const expiresIn = Number(tokenBody.expires_in) || 3600;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
  if (!accessToken) {
    throw gbpError("Missing access_token in GBP response", tokenBody);
  }

  // The granted scope list may differ from what we asked for —
  // Google's incremental consent. Store what was actually granted
  // so the resolver can check business.manage truthfully.
  const grantedScopes =
    typeof tokenBody.scope === "string"
      ? tokenBody.scope.split(/\s+/).filter(Boolean)
      : GBP_SCOPES;

  // 2. List accounts — best-effort. We use the result to seed
  //    externalAccountId + displayName so the connection card
  //    shows something meaningful before the user opens the
  //    picker. But this call is gated by the same Business
  //    Profile API approval that gates reviews, so on an
  //    unapproved project it will fail with 429 RESOURCE_EXHAUSTED.
  //    We do NOT want that to kill OAuth — the user has already
  //    granted consent and we owe them a working connection
  //    record. The picker will hit the same gate later (and
  //    short-circuit cleanly via the access-denied marker).
  let accountId = null;
  let accountName = null;
  try {
    const accountsRes = await fetch(`${GBP_ACCOUNT_MGMT_BASE}/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const accountsBody = await accountsRes.json().catch(() => ({}));
    if (accountsRes.ok && Array.isArray(accountsBody.accounts) && accountsBody.accounts.length > 0) {
      const first = accountsBody.accounts[0];
      // first.name is "accounts/{id}" — keep that as the sentinel
      // pre-location-picker externalAccountId.
      accountId = typeof first.name === "string" ? first.name : null;
      accountName =
        typeof first.accountName === "string"
          ? first.accountName
          : (typeof first.displayName === "string" ? first.displayName : null);
    } else if (!accountsRes.ok) {
      // Specific case: project not approved → RESOURCE_EXHAUSTED.
      // Log + tolerate so OAuth still completes; the picker will
      // surface the access-pending state.
      const status = accountsRes.status;
      const message = accountsBody?.error?.message ?? "";
      const isQuotaGate =
        status === 429 ||
        /RESOURCE_EXHAUSTED|requests per minute|quota/i.test(message);
      if (isQuotaGate) {
        console.warn(
          "[gbp.oauth] accounts.list quota-gated (non-fatal — OAuth completes without account name):",
          { status, message },
        );
      } else {
        // Real provider rejection (e.g. token misconfigured) —
        // surface so the user knows OAuth didn't fully succeed.
        throw gbpError(
          message || `GBP accounts.list failed with ${status}`,
          accountsBody,
          status,
        );
      }
    }
    // accountsRes.ok with zero accounts → still OK; we just have no
    // pickable accounts. The picker UI will show an empty state.
  } catch (err) {
    // Network or parse-only failures shouldn't kill OAuth — the
    // user can re-fetch the accounts list later. Re-throw real
    // provider rejections (those carry GBP_OAUTH_FAILED).
    if (err?.code === "GBP_OAUTH_FAILED") throw err;
    console.warn("[gbp.oauth] accounts.list errored (non-fatal):", err?.message);
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes: grantedScopes,
    externalAccountId: accountId, // sentinel — picker upgrades to accounts/.../locations/...
    displayName: accountName,
  };
}

// ── Authenticated Graph helpers ────────────────────────────────────────
//
// Used by the location picker, reviews poller, and reply send
// service. All take an already-decrypted access token (callers
// handle refresh via the existing tokenRefreshService pattern).

export async function listAccounts({ accessToken }) {
  const res = await fetch(`${GBP_ACCOUNT_MGMT_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw gbpError(
      body?.error?.message ?? `GBP accounts.list failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return Array.isArray(body.accounts) ? body.accounts : [];
}

export async function listLocationsForAccount({ accessToken, accountName }) {
  // The locations endpoint requires an explicit readMask. title +
  // storefrontAddress is the minimum useful for a picker.
  const params = new URLSearchParams({
    readMask: "name,title,storefrontAddress",
    pageSize: "100",
  });
  const url = `${GBP_BUSINESS_INFO_BASE}/${accountName}/locations?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw gbpError(
      body?.error?.message ?? `GBP locations.list failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return Array.isArray(body.locations) ? body.locations : [];
}

export async function listReviews({ accessToken, locationName, pageSize = 50 }) {
  // locationName: "accounts/{a}/locations/{l}"
  // Reviews API is still on the v4 (legacy) endpoint as of 2026.
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: "updateTime desc",
  });
  const url = `${GBP_V4_BASE}/${locationName}/reviews?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw gbpError(
      body?.error?.message ?? `GBP reviews.list failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return Array.isArray(body.reviews) ? body.reviews : [];
}

export async function updateReply({ accessToken, reviewName, comment }) {
  // reviewName: "accounts/{a}/locations/{l}/reviews/{r}"
  const url = `${GBP_V4_BASE}/${reviewName}/reply`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ comment }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw gbpError(
      body?.error?.message ?? `GBP updateReply failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return body;
}

// ── Token refresh ──────────────────────────────────────────────────────
//
// Wired into the existing tokenRefreshService — exported as
// `refreshAccessToken` to match the convention other Google OAuth
// modules expect.
export async function refreshAccessToken({ refreshToken }) {
  assertConfigured();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_BUSINESS_PROFILE_CLIENT_ID,
      client_secret: env.GOOGLE_BUSINESS_PROFILE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw gbpError(
      body?.error_description ?? `GBP refresh failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return {
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in) || 3600,
  };
}
