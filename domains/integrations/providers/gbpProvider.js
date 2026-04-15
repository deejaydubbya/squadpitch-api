// Google Business Profile provider — OAuth2 + Business Profile API.
//
// Fetches business info and reviews from Google Business Profile.
// Uses the same Google OAuth infrastructure as Sheets but with GBP-specific scopes.
//
// Config shape (stored in WorkspaceTechStackConnection.metadataJson):
//   {
//     accessToken: string (encrypted),
//     refreshToken: string (encrypted),
//     email: string,
//     accountId: string,
//     locationId: string,
//     locationName: string,
//     lastSyncedAt: string,
//     reviewCount: number,
//   }
//
// Env vars: GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REDIRECT_URI
// Falls back to GOOGLE_SHEETS_CLIENT_ID etc. if GBP-specific vars not set.

import { env } from "../../../config/env.js";
import { encryptToken, decryptToken } from "../../../lib/tokenCrypto.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MY_BUSINESS_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const ACCOUNT_MGMT_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const REVIEWS_API_BASE = "https://mybusiness.googleapis.com/v4";

// GBP scopes — business info + reviews
const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
].join(" ");

function getClientId() {
  return env.GBP_CLIENT_ID || env.GOOGLE_SHEETS_CLIENT_ID;
}

function getClientSecret() {
  return env.GBP_CLIENT_SECRET || env.GOOGLE_SHEETS_CLIENT_SECRET;
}

function getRedirectUri() {
  return env.GBP_REDIRECT_URI || env.GOOGLE_SHEETS_REDIRECT_URI;
}

// ── OAuth ──────────────────────────────────────────────────────────────

/**
 * Build the OAuth2 authorization URL for Google Business Profile.
 */
export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: getRedirectUri(),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GBP token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();

  // Get user email
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${data.access_token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const user = userRes.ok ? await userRes.json() : {};

  return {
    accessToken: encryptToken(data.access_token),
    refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : null,
    email: user.email ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(config) {
  if (!config.refreshToken) {
    throw new Error("No refresh token available — reconnect required");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      refresh_token: decryptToken(config.refreshToken),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const status = res.status;
    if (status === 400 || status === 401) {
      throw Object.assign(new Error("Refresh token expired — reconnect required"), { permanent: true });
    }
    throw new Error(`Token refresh failed (${status})`);
  }

  const data = await res.json();
  return {
    accessToken: encryptToken(data.access_token),
    expiresIn: data.expires_in,
  };
}

/**
 * Get a valid access token, refreshing if needed.
 */
async function getAccessToken(config) {
  const token = decryptToken(config.accessToken);

  // Test with a lightweight request
  const testRes = await fetch(`${ACCOUNT_MGMT_API}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });

  if (testRes.ok) return token;

  if (testRes.status === 401) {
    const refreshed = await refreshAccessToken(config);
    return decryptToken(refreshed.accessToken);
  }

  throw new Error(`GBP API error (${testRes.status})`);
}

// ── API Calls ──────────────────────────────────────────────────────────

/**
 * List GBP accounts.
 * @returns {Promise<Array<{ name: string, accountName: string, type: string }>>}
 */
export async function listAccounts(config) {
  const token = await getAccessToken(config);

  const res = await fetch(`${ACCOUNT_MGMT_API}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Failed to list GBP accounts (${res.status})`);

  const data = await res.json();
  return (data.accounts || []).map((a) => ({
    name: a.name, // accounts/xxx
    accountName: a.accountName || a.name,
    type: a.type || "PERSONAL",
  }));
}

/**
 * List locations for an account.
 * @returns {Promise<Array<{ name: string, title: string, address: object }>>}
 */
export async function listLocations(config, accountId) {
  const token = await getAccessToken(config);

  const res = await fetch(
    `${MY_BUSINESS_API}/${accountId}/locations?readMask=name,title,storefrontAddress,metadata,profile`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!res.ok) throw new Error(`Failed to list locations (${res.status})`);

  const data = await res.json();
  return (data.locations || []).map((l) => ({
    name: l.name, // locations/xxx
    title: l.title || "",
    address: l.storefrontAddress || null,
    metadata: l.metadata || null,
    profile: l.profile || null,
  }));
}

/**
 * Fetch reviews for a location.
 * @returns {Promise<{ reviews: Array, totalReviewCount: number, averageRating: number }>}
 */
export async function fetchReviews(config, accountId, locationId, { pageSize = 50, pageToken } = {}) {
  const token = await getAccessToken(config);
  const locationPath = `${accountId}/${locationId}`;

  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) params.set("pageToken", pageToken);

  const res = await fetch(
    `${REVIEWS_API_BASE}/${locationPath}/reviews?${params}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch reviews (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  const reviews = (data.reviews || []).map((r) => ({
    reviewId: r.reviewId || r.name?.split("/").pop(),
    reviewer: r.reviewer?.displayName || "Anonymous",
    starRating: mapStarRating(r.starRating),
    comment: r.comment || "",
    createTime: r.createTime || null,
    updateTime: r.updateTime || null,
    reply: r.reviewReply?.comment || null,
  }));

  return {
    reviews,
    totalReviewCount: data.totalReviewCount || reviews.length,
    averageRating: data.averageRating || null,
    nextPageToken: data.nextPageToken || null,
  };
}

/**
 * Fetch business info for a location.
 */
export async function fetchBusinessInfo(config, accountId, locationId) {
  const token = await getAccessToken(config);

  const res = await fetch(
    `${MY_BUSINESS_API}/${accountId}/${locationId}?readMask=name,title,storefrontAddress,phoneNumbers,websiteUri,regularHours,categories,profile`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!res.ok) throw new Error(`Failed to fetch business info (${res.status})`);

  const loc = await res.json();
  return {
    name: loc.title || "",
    description: loc.profile?.description || "",
    categories: [
      loc.categories?.primaryCategory?.displayName,
      ...(loc.categories?.additionalCategories || []).map((c) => c.displayName),
    ].filter(Boolean),
    address: loc.storefrontAddress || null,
    phone: loc.phoneNumbers?.primaryPhone || null,
    website: loc.websiteUri || null,
    hours: loc.regularHours?.periods || null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function mapStarRating(rating) {
  const map = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  if (typeof rating === "number") return rating;
  return map[rating] || null;
}
