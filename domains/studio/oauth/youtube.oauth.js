// YouTube (Google OAuth 2.0) flow.
//
// Auth URL: https://accounts.google.com/o/oauth2/v2/auth
// Token: POST https://oauth2.googleapis.com/token
// Channel info: GET https://www.googleapis.com/youtube/v3/channels?mine=true
//
// We request offline access to get a refresh token, since Google access
// tokens expire after 1 hour. The refresh token allows us to publish
// videos without re-authenticating.

import { env } from "../../../config/env.js";

// Scopes:
//   youtube.upload    — required to publish videos (existing).
//   youtube.readonly  — required to read channel info + commentThreads.list
//                       (the Inbox comment-ingestion path uses this).
//   youtube.force-ssl — required to POST comments via commentThreads.insert
//                       (the comment-reply send path). Sensitive scope —
//                       on an unverified Google project the OAuth consent
//                       screen will block non-test-users from granting it.
//                       We request it up-front so test-users granting consent
//                       today already get a force-ssl-capable token; the
//                       reply-action resolver checks for its presence on
//                       the connection's stored scopes before flipping
//                       REPLY_PUBLIC_COMMENT to available.
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

export const YOUTUBE_FORCE_SSL_SCOPE =
  "https://www.googleapis.com/auth/youtube.force-ssl";

function assertConfigured() {
  if (
    !env.YOUTUBE_CLIENT_ID ||
    !env.YOUTUBE_CLIENT_SECRET ||
    !env.YOUTUBE_REDIRECT_URI
  ) {
    throw Object.assign(new Error("YouTube credentials not configured"), {
      status: 500,
      code: "YOUTUBE_NOT_CONFIGURED",
    });
  }
}

function youtubeError(message, body, status = 502) {
  return Object.assign(new Error(message), {
    status,
    code: "YOUTUBE_OAUTH_FAILED",
    youtubeError: body,
  });
}

/**
 * Build the Google OAuth authorization URL for YouTube access.
 */
export function buildAuthUrl({ state }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    redirect_uri: env.YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange the authorization code for a YouTube access token.
 */
export async function exchangeCode({ code }) {
  assertConfigured();

  // 1. Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      redirect_uri: env.YOUTUBE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenBody.error) {
    throw youtubeError(
      tokenBody?.error_description ?? `YouTube token exchange failed with ${tokenRes.status}`,
      tokenBody,
      tokenRes.status
    );
  }

  const accessToken = tokenBody.access_token;
  const refreshToken = tokenBody.refresh_token ?? null;
  const expiresIn = Number(tokenBody.expires_in) || 3600;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  if (!accessToken) {
    throw youtubeError("Missing access_token in YouTube response", tokenBody);
  }

  // The granted scope list may differ from what we asked for — Google
  // omits scopes the user declined or that the project hasn't been
  // verified to request. Store what was actually granted so the
  // resolver can truthfully check for youtube.force-ssl before
  // offering the comment-reply action.
  const grantedScopes =
    typeof tokenBody.scope === "string"
      ? tokenBody.scope.split(/\s+/).filter(Boolean)
      : YOUTUBE_SCOPES;

  // 2. Get channel info for display name and channel ID
  let channelId = null;
  let displayName = null;
  try {
    const channelRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const channelBody = await channelRes.json().catch(() => ({}));
    if (channelRes.ok && channelBody?.items?.length > 0) {
      const ch = channelBody.items[0];
      channelId = ch.id;
      displayName = ch.snippet?.title ?? null;
    }
  } catch {
    // non-fatal
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes: grantedScopes,
    externalAccountId: channelId,
    displayName,
  };
}

// ── Token refresh ──────────────────────────────────────────────────────
//
// Wired into the existing tokenRefreshService — same shape as the GBP
// refresh helper so the comment poller's ensureFreshToken can use it.
export async function refreshAccessToken({ refreshToken }) {
  assertConfigured();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw youtubeError(
      body?.error_description ?? `YouTube refresh failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return {
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in) || 3600,
  };
}

// ── Authenticated Graph helpers ────────────────────────────────────────

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * List comment threads on a single video. Each thread contains the
 * top-level comment plus optional replies. We page through using
 * pageToken until exhausted or a soft cap is hit (poller passes
 * maxPages so we don't burn YouTube quota on a video with thousands
 * of comments — the ingestion layer is idempotent so missed comments
 * land on the next tick).
 *
 * order=time gives newest-first so a poller looking for new comments
 * can short-circuit once it sees the first already-ingested id.
 */
export async function listCommentThreads({
  accessToken,
  videoId,
  pageToken,
  maxResults = 50,
}) {
  const params = new URLSearchParams({
    part: "snippet,replies",
    videoId,
    maxResults: String(maxResults),
    order: "time",
    textFormat: "plainText",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const url = `${YOUTUBE_API_BASE}/commentThreads?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw youtubeError(
      body?.error?.message ?? `YouTube commentThreads.list failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return {
    items: Array.isArray(body.items) ? body.items : [],
    nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
  };
}

/**
 * Post a top-level reply on a comment thread. Requires
 * youtube.force-ssl on the granted scope set — the caller (reply
 * service) checks for it before calling. parentId is the comment id
 * being replied to; the body is the public-comment text.
 *
 * Returns the new comment id so the message persister can stamp
 * externalMessageId and dedupe on the next poll.
 */
export async function insertCommentReply({ accessToken, parentId, text }) {
  const url = `${YOUTUBE_API_BASE}/comments?part=snippet`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snippet: {
        parentId,
        textOriginal: text,
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw youtubeError(
      body?.error?.message ?? `YouTube comments.insert failed with ${res.status}`,
      body,
      res.status,
    );
  }
  return {
    commentId: body?.id ?? null,
    snippet: body?.snippet ?? null,
  };
}
