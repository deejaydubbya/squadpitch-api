// Instagram metrics adapter.
//
// Uses IG Graph API to fetch post insights + basic fields.
// GET /{media-id}/insights?metric=impressions,reach,saved,shares
// GET /{media-id}?fields=like_count,comments_count,timestamp
//
// Meta error codes worth classifying explicitly:
//   10  — "Application does not have permission for this action"
//          (token lacks instagram_manage_insights for /insights endpoint)
//   200 — "Permissions error"
//   230 — "Permission denied"
//   250 — "Requires extended permissions"
// All four mean "the token authenticated successfully but the granted
// scopes don't allow this call". We surface them as AUTH_FAILED so
// the service maps them to provider_permission_denied — distinct from
// the transient/retry path used for 5xx + 429.

import { META_GRAPH_BASE } from "../meta.constants.js";

const META_PERMISSION_CODES = new Set([10, 200, 230, 250]);

function isMetaPermissionError(body) {
  const code = body?.error?.code;
  return typeof code === "number" && META_PERMISSION_CODES.has(code);
}

function classifyMetaResponse(res, body) {
  if (res.status === 404) return { kind: "not_found" };
  if (res.status === 401 || res.status === 403) return { kind: "auth_failed" };
  if (res.status === 429 || res.status >= 500) {
    return { kind: "transient", status: res.status };
  }
  if (!res.ok && isMetaPermissionError(body)) {
    return { kind: "permission_denied", code: body?.error?.code, message: body?.error?.message };
  }
  if (!res.ok) {
    return { kind: "other_4xx", status: res.status, message: body?.error?.message };
  }
  return { kind: "ok" };
}

export async function fetchInstagramMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  // Fetch insights (impressions, reach, saved, shares)
  const insightsUrl =
    `${META_GRAPH_BASE}/${externalPostId}/insights` +
    `?metric=impressions,reach,saved,shares` +
    `&access_token=${encodeURIComponent(token)}`;

  const insightsRes = await fetch(insightsUrl);
  const insightsBody = await insightsRes.json().catch(() => ({}));
  const insightsClass = classifyMetaResponse(insightsRes, insightsBody);

  if (insightsClass.kind === "not_found") return null;
  if (insightsClass.kind === "auth_failed") {
    throw Object.assign(new Error("Instagram auth failed"), { code: "AUTH_FAILED" });
  }
  if (insightsClass.kind === "permission_denied") {
    // Most common cause: token missing instagram_manage_insights.
    throw Object.assign(
      new Error(
        `Instagram permission denied (${insightsClass.code}): ${insightsClass.message ?? ""}`.trim()
      ),
      { code: "AUTH_FAILED" }
    );
  }
  if (insightsClass.kind === "transient") {
    throw Object.assign(new Error(`Instagram API ${insightsClass.status}`), {
      transient: true,
      status: insightsClass.status,
    });
  }
  if (insightsClass.kind === "other_4xx") {
    throw Object.assign(new Error(insightsClass.message ?? "Instagram insights failed"), {
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
