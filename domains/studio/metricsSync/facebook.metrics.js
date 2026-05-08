// Facebook metrics adapter — partial-success.
//
// Strategy
// ────────
// Two independent data sources, fetched in sequence:
//   1. /{post-id}/insights?metric=…              → impressions / reach / clicks
//   2. /{post-id}?fields=reactions,comments,shares,permalink_url
//                                                → engagement summaries
//
// Either source alone counts as a successful sync. We only return
// null (→ provider_no_metrics) when BOTH are empty / unavailable.
// Insights commonly lag publishing by 15–60 min, so a fresh post
// often has engagement counts before insights numbers exist —
// previously this case surfaced as `provider_no_metrics`, which was
// wrong because real engagement was visible.
//
// Auth + rate-limit + 5xx errors on EITHER request still bubble up
// with the standard typed shapes (AUTH_FAILED / transient) so the
// service-level classifier behaves the same.
//
// External-post-id shape
// ──────────────────────
// Facebook publishing stores either the photo id (photo posts) or
// the page-id_post-id composite (text + link posts) — see
// publishing/channelAdapters/facebook.adapter.js. Both work against
// /{post-id}/insights AND /{post-id}?fields=… in current Graph
// versions. We log the shape (composite vs simple) for observability
// without exposing the token.

import { META_GRAPH_BASE } from "../meta.constants.js";

const FULL_METRIC_SET = [
  "post_impressions",
  "post_impressions_unique",
  "post_reactions_by_type_total",
  "post_clicks",
];
const MINIMAL_METRIC_SET = ["post_impressions", "post_impressions_unique"];

const ENGAGEMENT_FIELDS = [
  "reactions.limit(0).summary(true)",
  "comments.limit(0).summary(true)",
  "shares",
  "permalink_url",
];
// If reactions field is rejected by an older app permissions tier,
// retry the post-object call swapping reactions for likes.
const ENGAGEMENT_FIELDS_FALLBACK = [
  "likes.limit(0).summary(true)",
  "comments.limit(0).summary(true)",
  "shares",
  "permalink_url",
];

function buildInsightsUrl(externalPostId, metrics, token) {
  return (
    `${META_GRAPH_BASE}/${externalPostId}/insights` +
    `?metric=${metrics.join(",")}` +
    `&access_token=${encodeURIComponent(token)}`
  );
}

function buildPostObjectUrl(externalPostId, fields, token) {
  return (
    `${META_GRAPH_BASE}/${externalPostId}` +
    `?fields=${encodeURIComponent(fields.join(","))}` +
    `&access_token=${encodeURIComponent(token)}`
  );
}

function isInvalidMetricError(body, status) {
  return status === 400 && body?.error?.code === 100;
}

// Meta permission-error codes — token authenticated but scopes don't
// allow the call. See instagram.metrics.js for the full table.
const META_PERMISSION_CODES = new Set([10, 200, 230, 250]);
function isMetaPermissionError(body) {
  const code = body?.error?.code;
  return typeof code === "number" && META_PERMISSION_CODES.has(code);
}

function classifyHttpError(res, body) {
  if (res.status === 401 || res.status === 403) {
    return Object.assign(new Error("Facebook auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    return Object.assign(new Error(`Facebook API ${res.status}`), {
      transient: true,
      status: res.status,
    });
  }
  if (!res.ok && body && isMetaPermissionError(body)) {
    return Object.assign(
      new Error(
        `Facebook permission denied (${body.error.code}): ${body.error.message ?? ""}`.trim()
      ),
      { code: "AUTH_FAILED" }
    );
  }
  return null;
}

function sumReactions(reactions) {
  if (typeof reactions === "object" && reactions !== null) {
    return Object.values(reactions).reduce((a, b) => a + (Number(b) || 0), 0);
  }
  return Number(reactions) || 0;
}

function logIdShape(externalPostId) {
  const composite = typeof externalPostId === "string" && externalPostId.includes("_");
  console.log(
    `[FB_METRICS] externalPostId shape=${composite ? "composite_page_post" : "simple"} length=${
      typeof externalPostId === "string" ? externalPostId.length : 0
    }`
  );
}

// ── Insights call ────────────────────────────────────────────────────
//
// Returns one of:
//   { available: true, data: { impressions, reach, clicks, reactions } }
//   { available: false, reason: "post_not_found" }     → caller should null-out
//   { available: false, reason: "invalid_metric" | "empty" }
// Throws on auth / transient errors so the caller can re-throw.
async function fetchInsights({ externalPostId, token }) {
  // Try full set first.
  let res = await fetch(buildInsightsUrl(externalPostId, FULL_METRIC_SET, token));
  if (res.status === 404) return { available: false, reason: "post_not_found" };
  let body = await res.json().catch(() => ({}));
  const httpErr = classifyHttpError(res, body);
  if (httpErr) throw httpErr;

  // Meta error code 100 → retry with the documented baseline pair.
  if (!res.ok && isInvalidMetricError(body, res.status)) {
    res = await fetch(buildInsightsUrl(externalPostId, MINIMAL_METRIC_SET, token));
    body = await res.json().catch(() => ({}));
    const httpErr2 = classifyHttpError(res, body);
    if (httpErr2) throw httpErr2;
    if (!res.ok) {
      // Even minimal set is rejected → insights simply unavailable on
      // this post object. Engagement may still be available; keep going.
      return { available: false, reason: "invalid_metric" };
    }
  } else if (!res.ok) {
    // Some other 4xx — treat as insights-unavailable rather than fatal.
    // The post-object call will be the source of truth.
    return {
      available: false,
      reason: "http_" + res.status,
    };
  }

  // Empty data array means no insights yet. Common for fresh posts.
  const entries = body?.data ?? [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { available: false, reason: "empty" };
  }

  const map = {};
  for (const entry of entries) {
    map[entry.name] = entry.values?.[0]?.value ?? 0;
  }

  return {
    available: true,
    data: {
      impressions: Number(map.post_impressions) || 0,
      reach: Number(map.post_impressions_unique) || 0,
      clicks: Number(map.post_clicks) || 0,
      reactionsFromInsights: sumReactions(map.post_reactions_by_type_total),
    },
  };
}

// ── Post-object engagement call ──────────────────────────────────────
//
// Returns one of:
//   { available: true, data: { reactions, comments, shares, permalinkUrl, fallback } }
//   { available: false, reason: "post_not_found" | "empty" | "http_<status>" }
// Throws on auth / transient errors.
async function fetchPostObjectEngagement({ externalPostId, token }) {
  // Try with reactions first.
  let res = await fetch(buildPostObjectUrl(externalPostId, ENGAGEMENT_FIELDS, token));
  if (res.status === 404) return { available: false, reason: "post_not_found" };
  let body = await res.json().catch(() => ({}));
  let httpErr = classifyHttpError(res, body);
  if (httpErr) throw httpErr;

  let fallback = false;
  let reactionsCount = body?.reactions?.summary?.total_count;
  if (!res.ok || reactionsCount == null) {
    // Either the field was rejected (older app perms tier) or missing
    // entirely. Retry with likes.
    res = await fetch(buildPostObjectUrl(externalPostId, ENGAGEMENT_FIELDS_FALLBACK, token));
    body = await res.json().catch(() => ({}));
    httpErr = classifyHttpError(res, body);
    if (httpErr) throw httpErr;
    fallback = true;
    if (!res.ok) {
      return { available: false, reason: "http_" + res.status };
    }
    reactionsCount = body?.likes?.summary?.total_count;
  }

  const comments = body?.comments?.summary?.total_count;
  const shares = body?.shares?.count;
  const permalinkUrl = body?.permalink_url ?? null;

  // "available" means we got at least ONE engagement number. A response
  // with literally nothing isn't useful — fall through to no_metrics.
  const hasAny =
    (typeof reactionsCount === "number" && reactionsCount >= 0) ||
    (typeof comments === "number" && comments >= 0) ||
    (typeof shares === "number" && shares >= 0);

  if (!hasAny) {
    return { available: false, reason: "empty" };
  }

  return {
    available: true,
    data: {
      reactions: Number(reactionsCount) || 0,
      comments: Number(comments) || 0,
      shares: Number(shares) || 0,
      permalinkUrl,
      fallback: fallback ? "likes" : null,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────

export async function fetchFacebookMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;
  logIdShape(externalPostId);

  // Step 1 — insights (impressions / reach / clicks).
  let insights;
  try {
    insights = await fetchInsights({ externalPostId, token });
  } catch (err) {
    // Auth / transient — fail fast (the post-object call will fail the same way).
    throw err;
  }
  if (insights.reason === "post_not_found") return null;

  // Step 2 — post-object engagement (reactions/likes/comments/shares).
  let engagement;
  try {
    engagement = await fetchPostObjectEngagement({ externalPostId, token });
  } catch (err) {
    throw err;
  }
  if (engagement.reason === "post_not_found") return null;

  const insightsAvailable = insights.available === true;
  const engagementAvailable = engagement.available === true;

  if (!insightsAvailable && !engagementAvailable) {
    // Truly nothing — service-level classifier will surface this as
    // provider_no_metrics.
    return null;
  }

  // Reactions priority:
  //   1. post-object reactions/likes summary (most accurate; current count)
  //   2. fall back to insights' summed reactions object (lag-prone but better than 0)
  const reactions = engagementAvailable
    ? engagement.data.reactions
    : insights.data?.reactionsFromInsights ?? 0;

  const partialReasons = [];
  if (!insightsAvailable) {
    partialReasons.push(`facebook_insights_unavailable:${insights.reason}`);
  }
  if (engagementAvailable && engagement.data.fallback === "likes") {
    partialReasons.push("reactions_fallback_to_likes");
  }
  if (insightsAvailable && !engagementAvailable) {
    partialReasons.push(`engagement_unavailable:${engagement.reason}`);
  }

  return {
    raw: {
      impressions: insights.data?.impressions ?? 0,
      reach: insights.data?.reach ?? 0,
      clicks: insights.data?.clicks ?? 0,
      reactions,
      comments: engagement.data?.comments ?? 0,
      shares: engagement.data?.shares ?? 0,
      ...(partialReasons.length > 0 && {
        _partial: true,
        _partialReasons: partialReasons,
      }),
    },
    fetchedAt: new Date(),
  };
}
