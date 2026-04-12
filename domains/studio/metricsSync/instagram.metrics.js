// Instagram metrics adapter.
//
// Uses IG Graph API to fetch post insights + basic fields.
// GET /{media-id}/insights?metric=impressions,reach
// GET /{media-id}?fields=like_count,comments_count,timestamp

import { META_GRAPH_BASE } from "../meta.constants.js";

export async function fetchInstagramMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  // Fetch insights (impressions, reach, saved, shares)
  const insightsUrl =
    `${META_GRAPH_BASE}/${externalPostId}/insights` +
    `?metric=impressions,reach,saved,shares` +
    `&access_token=${encodeURIComponent(token)}`;

  const insightsRes = await fetch(insightsUrl);
  if (insightsRes.status === 404) return null;
  if (insightsRes.status === 401 || insightsRes.status === 403) {
    throw Object.assign(new Error("Instagram auth failed"), { code: "AUTH_FAILED" });
  }
  if (insightsRes.status === 429 || insightsRes.status >= 500) {
    throw Object.assign(new Error(`Instagram API ${insightsRes.status}`), { transient: true });
  }

  const insightsBody = await insightsRes.json().catch(() => ({}));
  if (!insightsRes.ok) {
    throw Object.assign(new Error(insightsBody?.error?.message ?? "Instagram insights failed"), {
      transient: true,
    });
  }

  // Parse insights into a flat object
  const insightMap = {};
  for (const entry of insightsBody?.data ?? []) {
    insightMap[entry.name] = entry.values?.[0]?.value ?? 0;
  }

  // Fetch basic fields (likes, comments)
  const fieldsUrl =
    `${META_GRAPH_BASE}/${externalPostId}` +
    `?fields=like_count,comments_count,timestamp` +
    `&access_token=${encodeURIComponent(token)}`;

  const fieldsRes = await fetch(fieldsUrl);
  const fieldsBody = await fieldsRes.json().catch(() => ({}));

  return {
    raw: {
      impressions: insightMap.impressions ?? 0,
      reach: insightMap.reach ?? 0,
      likes: fieldsBody.like_count ?? 0,
      comments: fieldsBody.comments_count ?? 0,
      saves: insightMap.saved ?? 0,
      shares: insightMap.shares ?? 0,
    },
    fetchedAt: new Date(),
  };
}
