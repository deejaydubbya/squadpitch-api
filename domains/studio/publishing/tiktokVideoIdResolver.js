// Resolves a TikTok publish_id to its final video_id by polling the
// TikTok publish status endpoint, then overwrites Draft.externalPostId
// with the resolved id so the metrics sync can subsequently fetch real
// counts.
//
// Why this exists
// ───────────────
// `publishing/channelAdapters/tiktok.adapter.js` calls
// /v2/post/publish/content/init/, which returns a `publish_id` (the
// upload-session handle). That id is stored as Draft.externalPostId.
// The metrics endpoint /v2/video/query/ requires the FINAL `video_id`,
// so before this resolver existed every TikTok metrics call silently
// returned empty data.
//
// Resolution shape
// ────────────────
// Returns one of:
//   { resolved: true,  status: "already_resolved",  videoId }
//   { resolved: true,  status: "newly_resolved",    videoId, publishId }
//   { resolved: false, status: "still_processing",  tiktokStatus }
//   { resolved: false, status: "publish_failed",    failReason? }
//   { resolved: false, status: "no_publish_id" | "draft_not_found"
//                            | "not_tiktok"      | "no_connection"
//                            | "token_refresh_failed" | "transient"
//                            | "permanent" }
// The string `status` is what the worker logs and what tests assert.

import { prisma } from "../../../prisma.js";
import { getConnectionForAdapter } from "../connection.service.js";
import { ensureValidAccessToken } from "../tokenRefreshService.js";

const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

// TikTok video_ids are pure-digit strings (typical 19-digit numeric).
const VIDEO_ID_PATTERN = /^\d+$/;

export function looksLikeTiktokVideoId(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  return VIDEO_ID_PATTERN.test(value);
}

/**
 * Try to resolve a TikTok draft's publish_id to a video_id.
 * Idempotent: if Draft.externalPostId is already a numeric video_id,
 * we return immediately without calling TikTok.
 *
 * Logs (non-PII; never includes the access token):
 *   [TIKTOK_RESOLVE] publish_id received     — we have a publish_id to resolve
 *   [TIKTOK_RESOLVE] video_id resolved       — wrote the final video_id
 *   [TIKTOK_RESOLVE] resolution failed       — terminal failure (publish failed)
 *   [TIKTOK_RESOLVE] still processing        — re-enqueue with backoff
 */
export async function resolveTiktokVideoId({ draftId, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;

  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      clientId: true,
      channel: true,
      externalPostId: true,
      variations: true,
    },
  });
  if (!draft) {
    return { resolved: false, status: "draft_not_found" };
  }
  if (draft.channel !== "TIKTOK") {
    return { resolved: false, status: "not_tiktok" };
  }
  if (!draft.externalPostId) {
    return { resolved: false, status: "no_publish_id" };
  }

  // Fast path: externalPostId is already a clean video_id — nothing to do.
  if (looksLikeTiktokVideoId(draft.externalPostId)) {
    return { resolved: true, status: "already_resolved", videoId: draft.externalPostId };
  }

  const publishId = draft.externalPostId;
  console.log(
    `[TIKTOK_RESOLVE] publish_id received draftId=${draft.id} clientId=${draft.clientId}`
  );

  // Get a live connection + refreshed token. We never log the token.
  let connection = await getConnectionForAdapter(draft.clientId, "TIKTOK");
  if (!connection || connection.status !== "CONNECTED") {
    return { resolved: false, status: "no_connection" };
  }
  try {
    connection = await ensureValidAccessToken(connection);
  } catch {
    return { resolved: false, status: "token_refresh_failed" };
  }

  // Hit TikTok status endpoint.
  let res;
  try {
    res = await fetchFn(STATUS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
  } catch (err) {
    // Network error — transient; worker will retry next tick.
    return { resolved: false, status: "transient", detail: err?.message ?? null };
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 5xx + 429 = transient; 4xx = permanent (likely malformed publish_id
    // or scope missing — re-trying won't help).
    const transient = res.status === 429 || res.status >= 500;
    return {
      resolved: false,
      status: transient ? "transient" : "permanent",
      httpStatus: res.status,
    };
  }

  const data = body?.data ?? {};
  const tiktokStatus = data.status ?? null;

  if (tiktokStatus === "PUBLISH_COMPLETE") {
    // TikTok's API spelling — "publicaly" not "publicly".
    const ids = data.publicaly_available_post_id ?? data.publicly_available_post_id ?? [];
    const videoId = Array.isArray(ids) ? ids[0] : ids;
    if (!videoId) {
      console.warn(
        `[TIKTOK_RESOLVE] resolution failed draftId=${draft.id} reason=no_video_id_in_complete_response`
      );
      return { resolved: false, status: "permanent", reason: "no_video_id_in_response" };
    }
    const videoIdStr = String(videoId);

    // Persist: overwrite externalPostId, store the publish_id in
    // variations as audit trail. Variations is the schema's free-form
    // JSON extension column — see prisma/schema.prisma Draft.variations.
    const baseVariations =
      draft.variations && typeof draft.variations === "object" && !Array.isArray(draft.variations)
        ? draft.variations
        : {};
    await prisma.draft.update({
      where: { id: draft.id },
      data: {
        externalPostId: videoIdStr,
        variations: { ...baseVariations, tiktokPublishId: publishId },
      },
    });

    console.log(
      `[TIKTOK_RESOLVE] video_id resolved draftId=${draft.id} videoId=${videoIdStr}`
    );
    return {
      resolved: true,
      status: "newly_resolved",
      videoId: videoIdStr,
      publishId,
    };
  }

  if (tiktokStatus === "FAILED") {
    const failReason = data.fail_reason ?? null;
    console.warn(
      `[TIKTOK_RESOLVE] resolution failed draftId=${draft.id} reason=${failReason ?? "unknown"}`
    );
    return { resolved: false, status: "publish_failed", failReason };
  }

  // PROCESSING_UPLOAD, SEND_TO_USER_INBOX, etc. — caller should re-poll.
  console.log(
    `[TIKTOK_RESOLVE] still processing draftId=${draft.id} tiktokStatus=${tiktokStatus}`
  );
  return { resolved: false, status: "still_processing", tiktokStatus };
}
