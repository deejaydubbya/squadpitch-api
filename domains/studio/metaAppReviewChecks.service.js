// Meta App Review API check tool — TEMPORARY.
//
// This module exists solely to make a single, real Graph API call
// against each of the two scopes Meta App Review wants to detect:
//   - read_insights                        (Facebook Page Insights)
//   - instagram_business_manage_insights   (Instagram Insights via
//                                           Instagram Login /
//                                           Business Login — see
//                                           Prompt 01 migration)
//
// It is wired into POST /api/v1/workspaces/:id/dev/meta/app-review-checks,
// which is gated by requireInternalAccess + requireClientOwner. The
// route is intentionally separate from the production metrics-sync
// path so it can be deleted in one PR after Meta approves.
//
// Removal checklist (post-App-Review):
//   1. Delete this file.
//   2. Remove the route block + service re-export referencing it.
//   3. Delete squadpitch-web/src/components/studio/analytics/
//      MetaAppReviewChecksButton.tsx and its hook + page wiring.
//   4. Delete docs/meta-app-review-api-checks.md.
//
// Security:
//   - Access tokens are NEVER returned. The `endpoint` field shown in
//     responses has the access_token query param stripped via
//     sanitizeEndpoint().
//   - Failure messages from Meta are preserved verbatim ONLY if they
//     don't contain the literal token. As an extra belt, every
//     response field is run through redactToken() before returning.
//   - Logs use the shared pino logger which already redacts
//     accessToken / refreshToken paths.

import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { getConnectionForAdapter } from "./connection.service.js";
import { ensureValidAccessToken } from "./tokenRefreshService.js";
import { META_GRAPH_BASE } from "./meta.constants.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sanitizeEndpoint(url) {
  // Strip access_token from the URL we echo back to the client/UI.
  // We use a literal replace rather than URL parsing so any malformed
  // input (e.g. a relative path) still gets scrubbed.
  return String(url).replace(/access_token=[^&]*/gi, "access_token=REDACTED");
}

function redactToken(value, token) {
  if (typeof value !== "string" || !token) return value;
  return value.split(token).join("REDACTED");
}

function checkResult({
  scope,
  attempted,
  success,
  endpoint,
  metrics = [],
  errorCode = null,
  message,
  token,
}) {
  return {
    scope,
    attempted,
    success,
    endpoint: sanitizeEndpoint(endpoint),
    metrics,
    errorCode,
    message: redactToken(message, token),
  };
}

async function metaGet(url) {
  // Returns { ok, status, body } regardless of HTTP error — callers
  // decide how to classify. Network-layer errors throw and are caught
  // by the orchestrator so the other check still runs.
  const res = await fetch(url, { method: "GET" });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ── Token scope verification (best-effort) ───────────────────────────

async function debugTokenScopes(accessToken) {
  // GET /debug_token?input_token=USER&access_token=APP_ID|APP_SECRET
  // Requires the app access token. If this fails we silently return
  // null — scope verification is a nice-to-have; the real signal is
  // whether the actual insights call succeeds.
  if (!env.META_APP_ID || !env.META_APP_SECRET) return null;
  const appAccessToken = `${env.META_APP_ID}|${env.META_APP_SECRET}`;
  const url = `${META_GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(
    accessToken
  )}&access_token=${encodeURIComponent(appAccessToken)}`;
  try {
    const { ok, body } = await metaGet(url);
    if (!ok) return null;
    const scopes = body?.data?.scopes;
    return Array.isArray(scopes) ? scopes : null;
  } catch {
    return null;
  }
}

// ── Facebook Page Insights check (read_insights) ─────────────────────

const FB_PRIMARY_METRIC = "page_impressions";
const FB_FALLBACK_METRIC = "page_post_engagements";

async function callPageInsights({ pageId, token, metric }) {
  const url = `${META_GRAPH_BASE}/${encodeURIComponent(
    pageId
  )}/insights?metric=${metric}&period=day&access_token=${encodeURIComponent(
    token
  )}`;
  const { ok, status, body } = await metaGet(url);
  return { url, ok, status, body };
}

export async function runFacebookPageInsightsCheck(connection) {
  const SCOPE = "read_insights";
  if (!connection) {
    return checkResult({
      scope: SCOPE,
      attempted: false,
      success: false,
      endpoint: `${META_GRAPH_BASE}/{pageId}/insights?metric=${FB_PRIMARY_METRIC}&period=day`,
      message: "No FACEBOOK ChannelConnection on this workspace",
    });
  }
  const pageId = connection.externalAccountId;
  const token = connection.accessToken;
  if (!pageId || !token) {
    return checkResult({
      scope: SCOPE,
      attempted: false,
      success: false,
      endpoint: `${META_GRAPH_BASE}/{pageId}/insights?metric=${FB_PRIMARY_METRIC}&period=day`,
      token,
      message: "Connection is missing externalAccountId or accessToken",
    });
  }

  // Primary metric.
  let attempt = await callPageInsights({ pageId, token, metric: FB_PRIMARY_METRIC });
  if (attempt.ok) {
    const metrics = (attempt.body?.data ?? []).map((d) => d.name).filter(Boolean);
    return checkResult({
      scope: SCOPE,
      attempted: true,
      success: true,
      endpoint: attempt.url,
      metrics,
      token,
      message: `Fetched ${metrics.length} metric series via ${FB_PRIMARY_METRIC}`,
    });
  }

  // If the primary metric was rejected for reasons that look like
  // "metric unavailable on this Graph API version" (Meta typically
  // returns code 100 / message "metric does not exist"), retry with
  // the fallback. Permission-denied errors (code 10/200/230) skip the
  // fallback — those mean the scope is missing, not the metric.
  const errCode = attempt.body?.error?.code ?? null;
  const errSubcode = attempt.body?.error?.error_subcode ?? null;
  const errMsg = attempt.body?.error?.message ?? `HTTP ${attempt.status}`;
  const isPermissionError = [10, 200, 230, 250, 190].includes(errCode);
  if (!isPermissionError) {
    const fallback = await callPageInsights({
      pageId,
      token,
      metric: FB_FALLBACK_METRIC,
    });
    if (fallback.ok) {
      const metrics = (fallback.body?.data ?? []).map((d) => d.name).filter(Boolean);
      return checkResult({
        scope: SCOPE,
        attempted: true,
        success: true,
        endpoint: fallback.url,
        metrics,
        token,
        message: `Fetched ${metrics.length} metric series via ${FB_FALLBACK_METRIC} (primary metric unavailable)`,
      });
    }
    // Both failed — return the fallback's error since it's the more
    // recent attempt.
    const fbCode = fallback.body?.error?.code ?? null;
    const fbMsg = fallback.body?.error?.message ?? `HTTP ${fallback.status}`;
    return checkResult({
      scope: SCOPE,
      attempted: true,
      success: false,
      endpoint: fallback.url,
      errorCode: fbCode != null ? String(fbCode) : null,
      token,
      message: `${FB_FALLBACK_METRIC}: ${fbMsg}`,
    });
  }

  return checkResult({
    scope: SCOPE,
    attempted: true,
    success: false,
    endpoint: attempt.url,
    errorCode: errCode != null ? String(errCode) : null,
    token,
    message: errSubcode
      ? `${errMsg} (subcode ${errSubcode})`
      : errMsg,
  });
}

// ── Instagram Insights check (instagram_business_manage_insights) ────

async function callIgUserInsights({ igUserId, token }) {
  // IG user/account-level insights. `reach` is a 2-day metric so we
  // request `period=day` which is the safe default. `profile_views`
  // requires the IG account to be a Business profile.
  const url = `${META_GRAPH_BASE}/${encodeURIComponent(
    igUserId
  )}/insights?metric=reach,profile_views&period=day&access_token=${encodeURIComponent(
    token
  )}`;
  const { ok, status, body } = await metaGet(url);
  return { url, ok, status, body };
}

async function callIgRecentMedia({ igUserId, token }) {
  const url = `${META_GRAPH_BASE}/${encodeURIComponent(
    igUserId
  )}/media?fields=id,caption,permalink,media_type,timestamp&limit=5&access_token=${encodeURIComponent(
    token
  )}`;
  const { ok, status, body } = await metaGet(url);
  return { url, ok, status, body };
}

async function callIgMediaInsights({ mediaId, token }) {
  const url = `${META_GRAPH_BASE}/${encodeURIComponent(
    mediaId
  )}/insights?metric=reach,likes,comments,saved,shares&access_token=${encodeURIComponent(
    token
  )}`;
  const { ok, status, body } = await metaGet(url);
  return { url, ok, status, body };
}

export async function runInstagramInsightsCheck(connection) {
  const SCOPE = "instagram_business_manage_insights";
  const PRIMARY_ENDPOINT_TEMPLATE = `${META_GRAPH_BASE}/{igUserId}/insights?metric=reach,profile_views&period=day`;
  if (!connection) {
    return checkResult({
      scope: SCOPE,
      attempted: false,
      success: false,
      endpoint: PRIMARY_ENDPOINT_TEMPLATE,
      message: "No INSTAGRAM ChannelConnection on this workspace",
    });
  }
  const igUserId = connection.externalAccountId;
  const token = connection.accessToken;
  if (!igUserId || !token) {
    return checkResult({
      scope: SCOPE,
      attempted: false,
      success: false,
      endpoint: PRIMARY_ENDPOINT_TEMPLATE,
      token,
      message: "Connection is missing externalAccountId or accessToken",
    });
  }

  // 1. Try IG user-level insights.
  const userAttempt = await callIgUserInsights({ igUserId, token });
  if (userAttempt.ok) {
    const metrics = (userAttempt.body?.data ?? []).map((d) => d.name).filter(Boolean);
    return checkResult({
      scope: SCOPE,
      attempted: true,
      success: true,
      endpoint: userAttempt.url,
      metrics,
      token,
      message: `Fetched ${metrics.length} user-level metric series`,
    });
  }

  const userErrCode = userAttempt.body?.error?.code ?? null;
  const userErrMsg = userAttempt.body?.error?.message ?? `HTTP ${userAttempt.status}`;
  const userIsPermission = [10, 200, 230, 250, 190].includes(userErrCode);

  // 2. If user-level failed for a non-permission reason (e.g. metric
  //    not available, or the IG account isn't a Business account),
  //    fall back to media insights on the most recent post.
  if (!userIsPermission) {
    const recent = await callIgRecentMedia({ igUserId, token });
    if (recent.ok) {
      const firstMedia = recent.body?.data?.[0];
      if (firstMedia?.id) {
        const mediaAttempt = await callIgMediaInsights({
          mediaId: firstMedia.id,
          token,
        });
        if (mediaAttempt.ok) {
          const metrics = (mediaAttempt.body?.data ?? [])
            .map((d) => d.name)
            .filter(Boolean);
          return checkResult({
            scope: SCOPE,
            attempted: true,
            success: true,
            endpoint: mediaAttempt.url,
            metrics,
            token,
            message: `Fetched ${metrics.length} media-level metric series (user-level insights unavailable; used media id ${firstMedia.id})`,
          });
        }
        const mediaErrCode = mediaAttempt.body?.error?.code ?? null;
        const mediaErrMsg =
          mediaAttempt.body?.error?.message ?? `HTTP ${mediaAttempt.status}`;
        return checkResult({
          scope: SCOPE,
          attempted: true,
          success: false,
          endpoint: mediaAttempt.url,
          errorCode: mediaErrCode != null ? String(mediaErrCode) : null,
          token,
          message: `media insights: ${mediaErrMsg}`,
        });
      }
      return checkResult({
        scope: SCOPE,
        attempted: true,
        success: false,
        endpoint: recent.url,
        token,
        message:
          "User-level insights unavailable and no recent media to fall back to",
      });
    }
    const recentErrCode = recent.body?.error?.code ?? null;
    const recentErrMsg = recent.body?.error?.message ?? `HTTP ${recent.status}`;
    return checkResult({
      scope: SCOPE,
      attempted: true,
      success: false,
      endpoint: recent.url,
      errorCode: recentErrCode != null ? String(recentErrCode) : null,
      token,
      message: `media list: ${recentErrMsg}`,
    });
  }

  return checkResult({
    scope: SCOPE,
    attempted: true,
    success: false,
    endpoint: userAttempt.url,
    errorCode: userErrCode != null ? String(userErrCode) : null,
    token,
    message: userErrMsg,
  });
}

// ── Orchestrator ─────────────────────────────────────────────────────

function buildNextSteps({ facebook, instagram, fbScopes, igScopes }) {
  const steps = [];
  const fbHasScope = !fbScopes || fbScopes.includes("read_insights");
  const igHasScope =
    !igScopes || igScopes.includes("instagram_business_manage_insights");

  if (!fbHasScope) {
    steps.push(
      "Disconnect and reconnect the Facebook channel to grant the read_insights scope."
    );
  }
  if (!igHasScope) {
    steps.push(
      "Confirm the connected Instagram account is a Business or Creator account and reconnect to grant `instagram_business_manage_insights`."
    );
  }
  if (!facebook.success && fbHasScope) {
    steps.push(
      `Facebook check failed: ${facebook.message}. Confirm the Page is published and not restricted.`
    );
  }
  if (!instagram.success && igHasScope) {
    steps.push(
      `Instagram check failed: ${instagram.message}. Confirm the connected Instagram account is a Business or Creator account and reconnect to grant \`instagram_business_manage_insights\`.`
    );
  }
  if (facebook.success && instagram.success) {
    steps.push(
      "Both calls succeeded. Meta App Review's required-API-call counter typically updates within 30–60 minutes."
    );
  }
  return steps;
}

export async function runMetaAppReviewChecks(clientId) {
  let fbConn = await getConnectionForAdapter(clientId, "FACEBOOK");
  let igConn = await getConnectionForAdapter(clientId, "INSTAGRAM");

  // Refresh tokens if near expiry. We swallow refresh errors here —
  // the underlying check will surface "AUTH_FAILED" via Meta's error
  // body, which is more useful than aborting the whole tool.
  if (fbConn) {
    try {
      fbConn = await ensureValidAccessToken(fbConn);
    } catch (err) {
      logger.warn(
        { code: err?.code },
        "[META_APP_REVIEW_CHECKS] facebook token refresh failed"
      );
    }
  }
  if (igConn) {
    try {
      igConn = await ensureValidAccessToken(igConn);
    } catch (err) {
      logger.warn(
        { code: err?.code },
        "[META_APP_REVIEW_CHECKS] instagram token refresh failed"
      );
    }
  }

  // Fire the two checks sequentially so a Meta rate-limit hit on one
  // doesn't poison the other. The volume here is two requests per
  // platform max — sequential is fine.
  let facebook;
  try {
    facebook = await runFacebookPageInsightsCheck(fbConn);
  } catch (err) {
    facebook = checkResult({
      scope: "read_insights",
      attempted: true,
      success: false,
      endpoint: `${META_GRAPH_BASE}/{pageId}/insights?metric=${FB_PRIMARY_METRIC}&period=day`,
      token: fbConn?.accessToken ?? null,
      message: `Unexpected error: ${err?.message ?? String(err)}`,
    });
  }

  let instagram;
  try {
    instagram = await runInstagramInsightsCheck(igConn);
  } catch (err) {
    instagram = checkResult({
      scope: "instagram_business_manage_insights",
      attempted: true,
      success: false,
      endpoint: `${META_GRAPH_BASE}/{igUserId}/insights?metric=reach,profile_views&period=day`,
      token: igConn?.accessToken ?? null,
      message: `Unexpected error: ${err?.message ?? String(err)}`,
    });
  }

  // Best-effort scope verification via debug_token. Surface the
  // granted scopes so the UI can flag stale-token / missing-scope
  // states without waiting for the full sync to fail.
  const fbScopes = fbConn ? await debugTokenScopes(fbConn.accessToken) : null;
  const igScopes = igConn ? await debugTokenScopes(igConn.accessToken) : null;

  const result = {
    facebook,
    instagram,
    tokenScopes: {
      facebook: fbScopes,
      instagram: igScopes,
    },
    nextSteps: buildNextSteps({ facebook, instagram, fbScopes, igScopes }),
  };

  logger.info(
    {
      clientId,
      fbSuccess: facebook.success,
      fbCode: facebook.errorCode,
      igSuccess: instagram.success,
      igCode: instagram.errorCode,
    },
    "[META_APP_REVIEW_CHECKS] completed"
  );

  return result;
}
