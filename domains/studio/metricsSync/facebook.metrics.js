// Facebook metrics adapter.
//
// Insights:  GET /{post-id}/insights?metric=…
// Object:    GET /{post-id}?fields=comments.summary(true),shares
//
// IMPORTANT: not every metric is valid for every Page/post type/API
// version. `post_reach` was a valid metric on older versions but
// /v17+ stopped accepting it on most page-post objects, returning:
//   (#100) The value must be a valid insights metric
// We use `post_impressions_unique` for reach instead — it's the
// documented stable post-level "unique users who saw this" metric and
// is what Meta itself recommends as the reach signal for posts.
//
// If Meta still rejects the safe set (e.g., niche page types where
// reactions_by_type_total isn't supported), we degrade to a minimal
// pair (post_impressions + post_impressions_unique) and return partial
// metrics with a `partial` warning. Comments and shares come from the
// post object regardless and are unaffected.

import { META_GRAPH_BASE } from "../meta.constants.js";

const FULL_METRIC_SET = [
  "post_impressions",
  "post_impressions_unique",
  "post_reactions_by_type_total",
  "post_clicks",
];

const MINIMAL_METRIC_SET = ["post_impressions", "post_impressions_unique"];

function buildInsightsUrl(externalPostId, metrics, token) {
  return (
    `${META_GRAPH_BASE}/${externalPostId}/insights` +
    `?metric=${metrics.join(",")}` +
    `&access_token=${encodeURIComponent(token)}`
  );
}

// Meta's #100 error message wording varies slightly across API versions
// (`The value must be a valid insights metric`, `is not a valid metric`,
// etc.). The error code is the stable signal.
function isInvalidMetricError(body, status) {
  if (status !== 400) return false;
  const code = body?.error?.code;
  // Meta error code 100 is "Invalid parameter". The combination of 400
  // status + code 100 on the insights endpoint is reliably this case.
  return code === 100;
}

async function fetchInsights({ url }) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function parseInsightsBody(body) {
  // Insights response: { data: [{ name, values: [{ value }] }, …] }
  const insightMap = {};
  for (const entry of body?.data ?? []) {
    insightMap[entry.name] = entry.values?.[0]?.value ?? 0;
  }
  return insightMap;
}

function sumReactions(reactions) {
  if (typeof reactions === "object" && reactions !== null) {
    return Object.values(reactions).reduce((a, b) => a + (Number(b) || 0), 0);
  }
  return Number(reactions) || 0;
}

export async function fetchFacebookMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  // Try the full metric set first.
  let { res, body } = await fetchInsights({
    url: buildInsightsUrl(externalPostId, FULL_METRIC_SET, token),
  });

  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("Facebook auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`Facebook API ${res.status}`), { transient: true, status: res.status });
  }

  // Meta-specific invalid-metric path: retry with the minimal safe set.
  // This is NOT transient — same metric will fail forever — so we don't
  // re-throw with `transient: true`. Instead we degrade and return what
  // we can.
  let partial = false;
  let partialReason = null;
  if (!res.ok && isInvalidMetricError(body, res.status)) {
    partial = true;
    partialReason = body?.error?.message ?? "Meta rejected one or more metrics";
    const minimal = await fetchInsights({
      url: buildInsightsUrl(externalPostId, MINIMAL_METRIC_SET, token),
    });
    res = minimal.res;
    body = minimal.body;
    // The minimal set is the documented baseline — if it ALSO 400s
    // with code 100, the post object simply doesn't expose insights
    // (e.g. an unsupported page type). Treat that as no_metrics.
    if (!res.ok) {
      if (isInvalidMetricError(body, res.status)) {
        return null;
      }
      throw Object.assign(new Error(body?.error?.message ?? "Facebook insights failed"), {
        transient: true,
        status: res.status,
      });
    }
  } else if (!res.ok) {
    throw Object.assign(new Error(body?.error?.message ?? "Facebook insights failed"), {
      transient: true,
      status: res.status,
    });
  }

  const insightMap = parseInsightsBody(body);
  const totalReactions = sumReactions(insightMap.post_reactions_by_type_total);

  // Comments + shares come from the post object — separate request that
  // doesn't go through the insights endpoint, so it's not affected by
  // the metric-validity dance above.
  const postUrl =
    `${META_GRAPH_BASE}/${externalPostId}` +
    `?fields=comments.summary(true),shares` +
    `&access_token=${encodeURIComponent(token)}`;
  const postRes = await fetch(postUrl);
  const postBody = await postRes.json().catch(() => ({}));

  return {
    raw: {
      impressions: Number(insightMap.post_impressions) || 0,
      reach: Number(insightMap.post_impressions_unique) || 0,
      reactions: totalReactions,
      comments: postBody?.comments?.summary?.total_count ?? 0,
      shares: postBody?.shares?.count ?? 0,
      clicks: Number(insightMap.post_clicks) || 0,
      // Surface partial-fetch state to the service layer for logging.
      // Never propagated upstream as a token-bearing string.
      ...(partial ? { _partial: true, _partialReason: partialReason } : {}),
    },
    fetchedAt: new Date(),
  };
}
