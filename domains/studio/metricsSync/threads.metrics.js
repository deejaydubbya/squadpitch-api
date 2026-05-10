// Threads (Meta) metrics adapter.
//
// Fetches per-thread insights via:
//   GET /{thread-id}/insights?metric=views,likes,replies,reposts,quotes,shares
//
// Spec: https://developers.facebook.com/docs/threads/insights/
//
// Threads exposes a smaller metric set than Instagram. We normalize
// into the cross-channel shape the orchestrator expects:
//   { raw: { impressions, reach, likes, comments, saves, shares,
//            reposts, quotes }, fetchedAt }
//
// Threads has no "impressions" metric distinct from "views" today —
// we map views→impressions so the cross-channel comparison stays
// meaningful. There's also no "reach" or "saves" — they're left as 0.
//
// Permission error classification mirrors instagram.metrics.js:
//   - 401/403 + Meta codes 10/200/230/250 → AUTH_FAILED
//     (token missing threads_manage_insights)
//   - 429 + 5xx → transient (orchestrator retries)
//   - 404 → null (post deleted / not yet indexed)

import { THREADS_GRAPH_BASE } from "../threads.constants.js";

const META_PERMISSION_CODES = new Set([10, 200, 230, 250]);

function isMetaPermissionError(body) {
  const code = body?.error?.code;
  return typeof code === "number" && META_PERMISSION_CODES.has(code);
}

function classifyResponse(res, body) {
  if (res.status === 404) return { kind: "not_found" };
  if (res.status === 401 || res.status === 403) return { kind: "auth_failed" };
  if (res.status === 429 || res.status >= 500) {
    return { kind: "transient", status: res.status };
  }
  if (!res.ok && isMetaPermissionError(body)) {
    return {
      kind: "permission_denied",
      code: body?.error?.code,
      message: body?.error?.message,
    };
  }
  if (!res.ok) {
    return {
      kind: "other_4xx",
      status: res.status,
      message: body?.error?.message,
    };
  }
  return { kind: "ok" };
}

export async function fetchThreadsMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  const url =
    `${THREADS_GRAPH_BASE}/${encodeURIComponent(externalPostId)}/insights` +
    `?metric=views,likes,replies,reposts,quotes,shares` +
    `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  const klass = classifyResponse(res, body);

  if (klass.kind === "not_found") return null;
  if (klass.kind === "auth_failed") {
    throw Object.assign(new Error("Threads auth failed"), { code: "AUTH_FAILED" });
  }
  if (klass.kind === "permission_denied") {
    // Most common cause: token missing threads_manage_insights.
    throw Object.assign(
      new Error(
        `Threads permission denied (${klass.code}): ${klass.message ?? ""}`.trim()
      ),
      { code: "AUTH_FAILED" }
    );
  }
  if (klass.kind === "transient") {
    throw Object.assign(new Error(`Threads API ${klass.status}`), {
      transient: true,
      status: klass.status,
    });
  }
  if (klass.kind === "other_4xx") {
    throw Object.assign(
      new Error(klass.message ?? "Threads insights failed"),
      { transient: true }
    );
  }

  // Flatten Meta's data: [{name, values:[{value}]}] shape.
  const insightMap = {};
  for (const entry of body?.data ?? []) {
    insightMap[entry.name] = entry.values?.[0]?.value ?? 0;
  }

  return {
    raw: {
      // Map views → impressions for cross-channel comparability.
      impressions: insightMap.views ?? 0,
      reach: 0, // Threads doesn't expose reach today
      likes: insightMap.likes ?? 0,
      comments: insightMap.replies ?? 0,
      saves: 0, // Threads doesn't expose saves
      shares: insightMap.shares ?? 0,
      reposts: insightMap.reposts ?? 0,
      quotes: insightMap.quotes ?? 0,
    },
    fetchedAt: new Date(),
  };
}
