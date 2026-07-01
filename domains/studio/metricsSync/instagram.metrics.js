// Instagram metrics adapter — partial-success, resilient metric ladder.
//
// Uses the Instagram API (Instagram Login / Business Login tokens — see
// Prompt 01 migration). The token is a direct Instagram long-lived USER
// token, NOT a Facebook Page token. Two independent sources:
//   GET /{media-id}/insights?metric=…   → reach / saved / shares / views / total_interactions
//   GET /{media-id}?fields=like_count,comments_count,timestamp
//
// Why a metric LADDER instead of one fixed set
// ────────────────────────────────────────────
// Meta's media-insights endpoint is all-or-nothing: a single unsupported
// metric (error code 100) rejects the ENTIRE request. The supported
// metric catalogue also varies by media type (feed image vs reel vs
// carousel), and Meta deprecated `impressions` for IG media (removed for
// media created after 2024-07). The previous adapter requested a fixed
// `impressions,reach,saved,shares` set and THREW `{ transient: true }` on
// any code-100 rejection — so for every account/media that no longer
// supports `impressions`, NO metric row was ever written and the sync
// retried forever. Result: published Instagram posts silently never
// appeared in Analytics. We now mirror facebook.metrics.js: try a rich
// set, step DOWN the ladder on code 100, and treat "insights unavailable"
// as non-fatal because the basic fields call (likes/comments) is an
// independent source.
//
// Partial success: a row is written whenever EITHER insights OR the basic
// fields call yields data — and a 200-OK-but-empty insights response
// (common for fresh posts, or accounts with limited insight metrics)
// still produces a zero-filled row so the post STAYS VISIBLE in Analytics
// instead of being dropped. We only return null (→ provider_no_metrics)
// when the media itself is gone (404) or both sources are truly
// unavailable.
//
// Meta error codes worth classifying explicitly (bubble up, don't ladder):
//   10 / 200 / 230 / 250 — token authenticated but scopes don't allow the
//      call (e.g. missing instagram_business_manage_insights) → AUTH_FAILED
//   429 / 5xx            — rate-limit / upstream → transient (retry)
//   100                  — unsupported/invalid metric → step down the ladder

import { INSTAGRAM_GRAPH_BASE } from "../meta.constants.js";

// Metric ladder, richest first. Each tier is ONE API call; on Meta error
// code 100 we step down to the next tier. `reach` is the single most
// universally-supported media insight, so it anchors the final tier.
// Likes/comments are intentionally NOT requested here — they come from the
// basic fields call (like_count/comments_count), which is more reliable
// and avoids a tier being rejected because `likes`/`comments` insights
// aren't supported for a given media type.
const IG_METRIC_LADDER = [
  ["reach", "saved", "shares", "views", "total_interactions"],
  ["reach", "saved", "shares"],
  ["reach"],
];

// Token authenticated but the granted scopes don't allow the call.
const META_PERMISSION_CODES = new Set([10, 200, 230, 250]);
function isMetaPermissionError(body) {
  const code = body?.error?.code;
  return typeof code === "number" && META_PERMISSION_CODES.has(code);
}
function isInvalidMetricError(body, status) {
  return status === 400 && body?.error?.code === 100;
}

// Returns a typed Error for the failure modes that must NOT be swallowed
// (auth, permission, transient), or null for "soft" failures the caller
// should treat as insights-unavailable.
function classifyHardError(res, body) {
  if (res.status === 401 || res.status === 403) {
    return Object.assign(new Error("Instagram auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    return Object.assign(new Error(`Instagram API ${res.status}`), {
      transient: true,
      status: res.status,
    });
  }
  if (!res.ok && isMetaPermissionError(body)) {
    // Most common cause: token missing instagram_business_manage_insights.
    // Reconnect through Instagram Business Login to grant it.
    return Object.assign(
      new Error(
        `Instagram permission denied (${body.error.code}): ${body.error.message ?? ""}`.trim()
      ),
      { code: "AUTH_FAILED" }
    );
  }
  return null;
}

function buildInsightsUrl(externalPostId, metrics, token) {
  return (
    `${INSTAGRAM_GRAPH_BASE}/${externalPostId}/insights` +
    `?metric=${metrics.join(",")}` +
    `&access_token=${encodeURIComponent(token)}`
  );
}

// ── Insights call (metric ladder) ────────────────────────────────────
//
// Returns one of:
//   { status: "ok", map, metrics }        — non-empty insights
//   { status: "empty", map: {} }          — 200 OK but no data yet
//   { status: "unavailable", reason }     — all tiers rejected (non-fatal)
//   { status: "not_found" }               — media 404
// Throws (AUTH_FAILED / transient) for hard errors.
async function fetchInsightsWithLadder({ externalPostId, token, log }) {
  let lastReason = "empty";

  for (let tier = 0; tier < IG_METRIC_LADDER.length; tier++) {
    const metrics = IG_METRIC_LADDER[tier];
    const res = await fetch(buildInsightsUrl(externalPostId, metrics, token));
    if (res.status === 404) return { status: "not_found" };

    const body = await res.json().catch(() => ({}));
    const hardErr = classifyHardError(res, body);
    if (hardErr) throw hardErr;

    if (res.ok) {
      const entries = Array.isArray(body?.data) ? body.data : [];
      if (entries.length === 0) {
        log(`insights empty (tier=${tier} metrics=${metrics.join(",")})`);
        return { status: "empty", map: {} };
      }
      const map = {};
      for (const entry of entries) {
        map[entry.name] = entry.values?.[0]?.value ?? 0;
      }
      return { status: "ok", map, metrics };
    }

    // Not OK and not a hard error. Code 100 → unsupported metric → step
    // down. Anything else → insights unavailable (fields call is truth).
    if (isInvalidMetricError(body, res.status)) {
      log(
        `metric rejected (code 100, tier=${tier} metrics=${metrics.join(",")}): ${body?.error?.message ?? ""}`
      );
      lastReason = "invalid_metric";
      continue;
    }
    log(`insights http ${res.status} (tier=${tier}): ${body?.error?.message ?? ""}`);
    return { status: "unavailable", reason: "http_" + res.status };
  }

  return { status: "unavailable", reason: lastReason };
}

// ── Basic fields call (likes/comments) ───────────────────────────────
//
// Returns { status: "ok", data } | { status: "unavailable", reason } |
// { status: "not_found" }. Throws on auth/transient.
async function fetchBasicFields({ externalPostId, token, log }) {
  const url =
    `${INSTAGRAM_GRAPH_BASE}/${externalPostId}` +
    `?fields=like_count,comments_count,timestamp` +
    `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  if (res.status === 404) return { status: "not_found" };

  const body = await res.json().catch(() => ({}));
  const hardErr = classifyHardError(res, body);
  if (hardErr) throw hardErr;

  if (!res.ok) {
    log(`fields http ${res.status}: ${body?.error?.message ?? ""}`);
    return { status: "unavailable", reason: "http_" + res.status };
  }

  return {
    status: "ok",
    data: {
      likes: Number(body.like_count) || 0,
      comments: Number(body.comments_count) || 0,
    },
  };
}

export async function fetchInstagramMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;
  const accountId = connection.externalAccountId ?? null;
  const log = (msg) =>
    console.log(`[IG_METRICS] account=${accountId ?? "?"} media=${externalPostId} ${msg}`);

  log(`fetch start ladder=${JSON.stringify(IG_METRIC_LADDER[0])}`);

  // 1. Insights (reach / saved / shares / views / total_interactions).
  const insights = await fetchInsightsWithLadder({ externalPostId, token, log });
  if (insights.status === "not_found") {
    log(`media not found (404) — dropping post`);
    return null;
  }
  const insightsOk = insights.status === "ok";
  const insightsReachable = insightsOk || insights.status === "empty";

  // 2. Basic fields (likes / comments) — independent engagement source.
  const fields = await fetchBasicFields({ externalPostId, token, log });
  // A fields 404 only drops the post when insights are ALSO unavailable —
  // if insights are reachable the media clearly exists, so keep that row.
  if (fields.status === "not_found" && !insightsReachable) {
    log(`media not found (404) on fields — dropping post`);
    return null;
  }
  const fieldsOk = fields.status === "ok";

  // Only drop when NOTHING is available. A 0/empty insight response is
  // still "reachable" (the media exists) and must keep the post visible,
  // so `empty` counts as available-with-zeros.
  if (!insightsReachable && !fieldsOk) {
    log(
      `no metrics available (insights=${insights.status} fields=${fields.status}) — dropping post`
    );
    return null;
  }

  const map = insights.map ?? {};
  // Meta deprecated `impressions` for IG media; `views` is the modern
  // analogue and populates the cross-channel "impressions" column so the
  // Analytics UI isn't left blank. Falls back to reach downstream when
  // neither is present (see normalization.service.js INSTAGRAM rule).
  const raw = {
    impressions: Number(map.views ?? map.impressions ?? 0) || 0,
    reach: Number(map.reach ?? 0) || 0,
    likes: fieldsOk ? fields.data.likes : 0,
    comments: fieldsOk ? fields.data.comments : 0,
    saves: Number(map.saved ?? 0) || 0,
    shares: Number(map.shares ?? 0) || 0,
    views: Number(map.views ?? 0) || 0,
    totalInteractions: Number(map.total_interactions ?? 0) || 0,
  };

  const partialReasons = [];
  if (!insightsOk) {
    partialReasons.push(
      `insights_${insights.status}${insights.reason ? ":" + insights.reason : ""}`
    );
  }
  if (!fieldsOk) {
    partialReasons.push(`fields_${fields.status}${fields.reason ? ":" + fields.reason : ""}`);
  }

  log(
    `stored row reach=${raw.reach} views=${raw.views} likes=${raw.likes} ` +
      `comments=${raw.comments} saves=${raw.saves} shares=${raw.shares}` +
      (partialReasons.length ? ` partial=${partialReasons.join("|")}` : "")
  );

  return {
    raw: {
      ...raw,
      ...(partialReasons.length > 0 && { _partial: true, _partialReasons: partialReasons }),
    },
    fetchedAt: new Date(),
  };
}
