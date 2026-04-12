// Facebook metrics adapter.
//
// GET /{post-id}/insights?metric=post_impressions,post_reach,post_reactions_by_type_total,post_clicks

import { META_GRAPH_BASE } from "../meta.constants.js";

export async function fetchFacebookMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  const insightsUrl =
    `${META_GRAPH_BASE}/${externalPostId}/insights` +
    `?metric=post_impressions,post_reach,post_reactions_by_type_total,post_clicks` +
    `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(insightsUrl);
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("Facebook auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`Facebook API ${res.status}`), { transient: true });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body?.error?.message ?? "Facebook insights failed"), {
      transient: true,
    });
  }

  const insightMap = {};
  for (const entry of body?.data ?? []) {
    insightMap[entry.name] = entry.values?.[0]?.value ?? 0;
  }

  // Reactions can be an object { like: N, love: N, ... } — sum all types
  const reactions = insightMap.post_reactions_by_type_total;
  const totalReactions =
    typeof reactions === "object" && reactions !== null
      ? Object.values(reactions).reduce((a, b) => a + (Number(b) || 0), 0)
      : Number(reactions) || 0;

  // Fetch comments + shares from the post object
  const postUrl =
    `${META_GRAPH_BASE}/${externalPostId}` +
    `?fields=comments.summary(true),shares` +
    `&access_token=${encodeURIComponent(token)}`;

  const postRes = await fetch(postUrl);
  const postBody = await postRes.json().catch(() => ({}));

  return {
    raw: {
      impressions: Number(insightMap.post_impressions) || 0,
      reach: Number(insightMap.post_reach) || 0,
      reactions: totalReactions,
      comments: postBody?.comments?.summary?.total_count ?? 0,
      shares: postBody?.shares?.count ?? 0,
      clicks: Number(insightMap.post_clicks) || 0,
    },
    fetchedAt: new Date(),
  };
}
