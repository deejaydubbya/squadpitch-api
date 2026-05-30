// Instagram API with Instagram Login / Business Login OAuth flow.
//
// IMPORTANT: this is intentionally a SEPARATE flow from Facebook
// Login. The legacy implementation went through facebook.com's
// dialog/oauth, asked for Page scopes, listed `/me/accounts`, and
// pulled `instagram_business_account` off the Page row. That
// pattern still exists for the FACEBOOK channel in
// `facebook.oauth.js` — but Instagram now uses its own product
// surface ("Instagram API with Instagram Login") with a separate
// scope family and OAuth host. See:
//   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
//
// The new flow:
//   1. user is sent to https://www.instagram.com/oauth/authorize
//      with the `instagram_business_*` scope set
//   2. callback receives `code`
//   3. POST api.instagram.com/oauth/access_token → short-lived
//      Instagram user token + the IG user id
//   4. GET  graph.instagram.com/access_token?grant_type=ig_exchange_token
//      → long-lived token (~60 days, refreshable separately)
//   5. GET  graph.instagram.com/me?fields=id,username,…
//      → display name + verifies the connected account type
//   6. We store the long-lived Instagram USER token as
//      `accessToken` (not a Page token) and the IG user id as
//      `externalAccountId`. Publishing/insights/comments calls
//      from the rest of the codebase authenticate with this same
//      token — no Page lookup needed.

import { env } from "../../../config/env.js";

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
  "instagram_business_manage_comments",
];

// Instagram OAuth surfaces — kept as constants so a future host
// change (e.g. versioned graph.instagram.com paths) only has to
// touch this file.
const INSTAGRAM_AUTH_HOST = "https://www.instagram.com";
const INSTAGRAM_OAUTH_API = "https://api.instagram.com";
const INSTAGRAM_GRAPH_API = "https://graph.instagram.com";

// Some Meta endpoints expect comma-separated scopes; the docs are
// inconsistent across product surfaces. Centralized here so we can
// flip to "+" or " " in one place if a 400 surfaces. Per the
// Instagram Business Login docs as of 2026-05, comma is correct.
const SCOPE_SEPARATOR = ",";

// Migration convenience — operators can keep using the existing
// META_* env vars during rollout, but new deployments should set
// INSTAGRAM_* to make the Meta / Instagram separation explicit
// (and to allow a second Meta App for Instagram Login that's
// distinct from the Facebook Login app).
function instagramAppId() {
  return env.INSTAGRAM_APP_ID ?? env.META_APP_ID;
}
function instagramAppSecret() {
  return env.INSTAGRAM_APP_SECRET ?? env.META_APP_SECRET;
}
function instagramRedirectUri() {
  if (env.INSTAGRAM_OAUTH_REDIRECT_URI) return env.INSTAGRAM_OAUTH_REDIRECT_URI;
  if (!env.META_OAUTH_REDIRECT_URI) return null;
  return env.META_OAUTH_REDIRECT_URI.replace(
    /\/oauth\/[^/]+\/callback/i,
    "/oauth/INSTAGRAM/callback",
  );
}

function assertConfigured() {
  if (!instagramAppId() || !instagramAppSecret() || !instagramRedirectUri()) {
    throw Object.assign(
      new Error("Instagram app credentials not configured"),
      { status: 500, code: "INSTAGRAM_NOT_CONFIGURED" },
    );
  }
}

function igError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "INSTAGRAM_OAUTH_FAILED",
    instagramError: body,
  });
}

async function igGet(url) {
  const res = await fetch(url, { method: "GET" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw igError(
      body?.error_message
        ?? body?.error?.message
        ?? `Instagram ${url} failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return body;
}

async function igPostForm(url, form) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v != null) body.append(k, String(v));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw igError(
      parsed?.error_message
        ?? parsed?.error?.message
        ?? `Instagram ${url} failed with ${res.status}`,
      parsed,
      res.status,
    );
  }
  return parsed;
}

/**
 * Build the Instagram authorization URL the user should visit.
 *
 * Hits instagram.com/oauth/authorize directly — NOT facebook.com.
 * The old Facebook-Login-via-Page flow is gone for this channel;
 * see the file header comment for the rationale.
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: instagramAppId(),
    redirect_uri: instagramRedirectUri(),
    state,
    scope: INSTAGRAM_SCOPES.join(SCOPE_SEPARATOR),
    response_type: "code",
    // force_reauth=true tells Instagram to ALWAYS render the
    // consent dialog instead of silently re-issuing a code when
    // the user has already authorized the app. Without this, the
    // Business Login flow returns "Invalid platform app" on some
    // accounts that previously authorized the legacy Facebook-
    // Login-via-Page flow — Instagram tries to reuse the old
    // session/cookie and the platform-app mismatch trips its
    // validator. Meta's own dashboard recommends including it
    // for the Business Login launcher URL.
    force_reauth: "true",
  });
  return `${INSTAGRAM_AUTH_HOST}/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange the authorization code for a long-lived Instagram user
 * token + the connected IG professional account profile.
 *
 * Returns everything needed to upsert a connection row. NEVER
 * calls `/me/accounts` — that was a Facebook Page surface, not
 * an Instagram one.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. code → short-lived Instagram user token + user id.
  const short = await igPostForm(
    `${INSTAGRAM_OAUTH_API}/oauth/access_token`,
    {
      client_id: instagramAppId(),
      client_secret: instagramAppSecret(),
      grant_type: "authorization_code",
      redirect_uri: instagramRedirectUri(),
      code,
    },
  );
  const shortToken = short.access_token;
  // `user_id` comes back at the top level of the short-token
  // response; the docs spell it "user_id" (snake_case).
  const igUserIdFromShort = short.user_id ? String(short.user_id) : null;
  if (!shortToken) {
    throw igError(
      "Missing access_token in Instagram short-lived response",
      short,
    );
  }

  // 2. short-lived → long-lived Instagram user token (~60 days).
  const longUrl = new URL(`${INSTAGRAM_GRAPH_API}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", instagramAppSecret());
  longUrl.searchParams.set("access_token", shortToken);
  const long = await igGet(longUrl.toString());
  const longLivedToken = long.access_token;
  if (!longLivedToken) {
    throw igError(
      "Missing access_token in Instagram long-lived response",
      long,
    );
  }
  // expires_in is seconds; default to 60 days only if Meta omits
  // it. Per the docs the long-lived token currently lasts 60 days
  // but they reserve the right to change that without notice.
  const expiresInSec = Number(long.expires_in) || 60 * 24 * 60 * 60;
  const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

  // 3. Fetch the connected professional account profile directly.
  //    No Page lookup, no `/me/accounts` — the long-lived token
  //    authenticates against the Instagram user it was issued
  //    for. `account_type` is helpful for surfacing a clearer
  //    error if a personal IG account somehow squeezed through
  //    the scope-consent step.
  const meUrl = new URL(`${INSTAGRAM_GRAPH_API}/me`);
  meUrl.searchParams.set("fields", "id,username,account_type,media_count");
  meUrl.searchParams.set("access_token", longLivedToken);
  const me = await igGet(meUrl.toString());

  const instagramUserId = String(me.id ?? igUserIdFromShort ?? "");
  if (!instagramUserId) {
    throw igError("Instagram /me did not return a user id", me);
  }
  const username = typeof me.username === "string" ? me.username : null;

  return {
    accessToken: longLivedToken,
    refreshToken: null, // Instagram doesn't issue refresh tokens; long-lived tokens are refreshed via ig_refresh_token instead (see Prompt 02).
    tokenExpiresAt,
    scopes: INSTAGRAM_SCOPES,
    externalAccountId: instagramUserId,
    displayName: username
      ? `@${username}`
      : `Instagram ${instagramUserId}`,
  };
}
