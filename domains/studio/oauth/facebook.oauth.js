// Meta (Facebook Login) -> Facebook Page publishing OAuth flow.
//
// Shares META_APP_ID / META_APP_SECRET with Instagram — both use the
// Facebook Login dialog. The difference is in scopes (page management
// instead of IG content publish) and what we store: the Facebook Page ID
// and page access token rather than an IG Business account.

import { env } from "../../../config/env.js";
import { META_GRAPH_VERSION, META_GRAPH_BASE } from "../meta.constants.js";

const GRAPH_BASE = META_GRAPH_BASE;

/**
 * Derive the Facebook redirect URI from the Instagram one by swapping
 * the channel segment. e.g.:
 *   .../oauth/instagram/callback  ->  .../oauth/FACEBOOK/callback
 */
function getFacebookRedirectUri() {
  return env.META_OAUTH_REDIRECT_URI.replace(
    /\/oauth\/[^/]+\/callback/i,
    "/oauth/FACEBOOK/callback"
  );
}

export const FACEBOOK_SCOPES = [
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_show_list",
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
 * Build the Facebook Login dialog URL for page-level access.
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: getFacebookRedirectUri(),
    state,
    scope: FACEBOOK_SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Exchange the authorization code for a Facebook Page access token.
 * Returns everything needed to upsert a connection row.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. code -> short-lived user token
  const short = await metaGet("/oauth/access_token", {
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: getFacebookRedirectUri(),
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
  const expiresInSec = Number(long.expires_in) || 60 * 24 * 60 * 60;
  const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

  // 3. list FB pages
  const pagesRes = await metaGet("/me/accounts", {
    access_token: userToken,
    fields: "id,name,access_token",
    limit: 100,
  });
  const pages = Array.isArray(pagesRes.data) ? pagesRes.data : [];
  if (pages.length === 0) {
    throw metaError(
      "No Facebook Page found on this account.",
      pagesRes,
      400
    );
  }

  // 4. pick the first page
  const page = pages[0];
  const pageAccessToken = page.access_token;
  const pageId = page.id;
  const pageName = page.name ?? null;

  return {
    accessToken: pageAccessToken,
    refreshToken: null, // Meta does not use refresh tokens
    tokenExpiresAt,
    scopes: FACEBOOK_SCOPES,
    externalAccountId: pageId,
    displayName: pageName,
  };
}
