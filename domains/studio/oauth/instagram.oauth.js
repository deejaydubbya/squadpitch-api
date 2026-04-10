// Meta (Facebook Login) -> Instagram Graph API OAuth flow.
//
// Minimal implementation for Phase 2. Exchanges a
// Facebook Login authorization code into:
//   1. short-lived user token
//   2. long-lived user token (~60 days)
//   3. FB Page list  (user must have a Page connected to an IG Business account)
//   4. IG Business user id + Page access token (what we actually store)
//
// Spec references:
//   https://developers.facebook.com/docs/instagram-api/getting-started
//   https://developers.facebook.com/docs/facebook-login/guides/access-tokens
//
// We store the Page access token (not the user token) because IG publishing
// calls are authenticated against the Page, which grants access to the
// linked IG Business account.

import { env } from "../../../config/env.js";
import { META_GRAPH_VERSION, META_GRAPH_BASE } from "../meta.constants.js";

const GRAPH_VERSION = META_GRAPH_VERSION;
const GRAPH_BASE = META_GRAPH_BASE;

export const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

function assertConfigured() {
  if (
    !env.META_APP_ID ||
    !env.META_APP_SECRET ||
    !env.META_OAUTH_REDIRECT_URI
  ) {
    throw Object.assign(new Error("Meta app credentials not configured"), {
      status: 500,
      code: "META_NOT_CONFIGURED",
    });
  }
}

function metaError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "META_OAUTH_FAILED",
    metaError: body,
  });
}

async function metaGet(path, query) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { method: "GET" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw metaError(
      body?.error?.message ?? `Meta ${path} failed with ${res.status}`,
      body,
      res.status
    );
  }
  return body;
}

/**
 * Build the Facebook Login dialog URL the user should visit.
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: env.META_OAUTH_REDIRECT_URI,
    state,
    scope: INSTAGRAM_SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Exchange the authorization code for a usable IG publishing credential.
 * Returns everything needed to upsert a connection row.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. code -> short-lived user token
  const short = await metaGet("/oauth/access_token", {
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: env.META_OAUTH_REDIRECT_URI,
    code,
  });
  const shortToken = short.access_token;
  if (!shortToken) throw metaError("Missing short-lived token in response", short);

  // 2. short-lived -> long-lived user token (~60 days)
  const long = await metaGet("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: shortToken,
  });
  const userToken = long.access_token;
  if (!userToken) throw metaError("Missing long-lived token in response", long);
  const expiresInSec = Number(long.expires_in) || 60 * 24 * 60 * 60; // fallback 60d
  const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

  // 3. list FB pages — use nested field expansion to pull the IG username
  // in the same call, saving a round trip vs. a separate `/${igUserId}`
  // lookup.
  const pagesRes = await metaGet("/me/accounts", {
    access_token: userToken,
    fields: "id,name,access_token,instagram_business_account{id,username}",
    limit: 100,
  });
  const pages = Array.isArray(pagesRes.data) ? pagesRes.data : [];
  if (pages.length === 0) {
    throw metaError(
      "No Facebook Page found on this account. Connect an IG Business account to a Page first.",
      pagesRes,
      400
    );
  }

  // 4. pick the first page with an IG Business account
  const pageWithIg = pages.find(
    (p) => p.instagram_business_account && p.instagram_business_account.id
  );
  if (!pageWithIg) {
    throw metaError(
      "None of your Pages have a linked Instagram Business account.",
      pagesRes,
      400
    );
  }

  const igAccount = pageWithIg.instagram_business_account;
  const igUserId = igAccount.id;
  const igUsername = igAccount.username ?? null;
  const pageAccessToken = pageWithIg.access_token;
  const pageName = pageWithIg.name ?? null;

  return {
    accessToken: pageAccessToken,
    refreshToken: null, // FB does not use refresh tokens
    tokenExpiresAt,
    scopes: INSTAGRAM_SCOPES,
    externalAccountId: igUserId,
    displayName: igUsername ? `@${igUsername}` : pageName,
  };
}
