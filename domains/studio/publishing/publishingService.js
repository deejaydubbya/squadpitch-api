// Publishing orchestrator.
//
// Single entry point used by the POST /drafts/:id/publish route. Decides
// between local-only publish (no connection) and external publish via a
// channel adapter.
//
// Semantics (see plan "Publish flow semantics"):
//  - no connection              -> local-only transition to PUBLISHED with warning
//  - connection + adapter OK    -> external publish, then transition PUBLISHED
//  - connection + adapter fail  -> draft STAYS in APPROVED/SCHEDULED, error logged
//  - idempotency: short-circuit if draft already has externalPostId + PUBLISHED

import { randomUUID } from "node:crypto";
import { prisma } from "../../../prisma.js";
import { transitionDraft } from "../draftWorkflow.service.js";
import {
  getConnectionForAdapter,
  updateConnectionStatus,
} from "../connection.service.js";
import { formatDraft } from "../draft.service.js";
import { getAdapterForChannel } from "./channelAdapters/index.js";
import { enqueueNotification } from "../../notifications/notification.service.js";
import { ensureValidAccessToken } from "../tokenRefreshService.js";

// ── Pre-publish media validation ───────────────────────────────────────

const VIDEO_REQUIRED_CHANNELS = new Set(["YOUTUBE"]);
const MEDIA_REQUIRED_CHANNELS = new Set(["TIKTOK"]);

/**
 * Validate draft media against channel requirements before publishing.
 * Returns { errors: string[], warnings: string[] }.
 */
export function validateDraftMedia(draft) {
  const errors = [];
  const warnings = [];
  const channel = draft.channel;
  const hasMedia = Boolean(draft.mediaUrl);
  const isVideo = draft.mediaType === "video";

  // Blocking: YouTube requires video
  if (VIDEO_REQUIRED_CHANNELS.has(channel) && !isVideo) {
    errors.push(`${channel} requires a video. Please attach a video before publishing.`);
  }

  // Blocking: TikTok requires media
  if (MEDIA_REQUIRED_CHANNELS.has(channel) && !hasMedia) {
    errors.push(`${channel} requires media. Please attach an image or video before publishing.`);
  }

  // Warning: Instagram without media
  if (channel === "INSTAGRAM" && !hasMedia) {
    warnings.push("Instagram posts perform significantly better with media attached.");
  }

  return { errors, warnings };
}

// Narrow mediaProfile select: the Instagram adapter only needs
// assetLibraryJson[0].url as a fallback media source, so avoid pulling the
// rest of the (potentially large) media profile blob into memory.
const DRAFT_WITH_CLIENT_INCLUDE = {
  client: {
    include: {
      mediaProfile: { select: { assetLibraryJson: true } },
    },
  },
};

async function loadDraftWithClient(draftId) {
  return prisma.draft.findUnique({
    where: { id: draftId },
    include: DRAFT_WITH_CLIENT_INCLUDE,
  });
}

/**
 * Resolve draft.createdBy (auth0Sub) → userId, then enqueue notification.
 * Fire-and-forget — never throws.
 */
function notifyDraftOwner(draft, eventType, payload) {
  prisma.user
    .findUnique({ where: { auth0Sub: draft.createdBy }, select: { id: true } })
    .then((user) => {
      if (user) {
        enqueueNotification({
          userId: user.id,
          eventType,
          payload,
          resourceType: "draft",
          resourceId: draft.id,
        }).catch(() => {});
      }
    })
    .catch(() => {});
}

/**
 * Publish a draft through its channel adapter (or fall back to local).
 *
 * @param {{ draftId: string, actorSub: string, source?: 'manual'|'scheduled' }} params
 * @returns {Promise<object>} the formatted draft
 */
export async function publishDraft({ draftId, actorSub, source = "manual" }) {
  const draft = await loadDraftWithClient(draftId);
  if (!draft) {
    throw Object.assign(new Error("Draft not found"), {
      status: 404,
      code: "DRAFT_NOT_FOUND",
    });
  }

  // Idempotency: already published externally
  if (draft.status === "PUBLISHED" && draft.externalPostId) {
    return formatDraft(draft);
  }

  // Status gate — mirrors draftWorkflow.VALID_TRANSITIONS
  if (!["APPROVED", "SCHEDULED"].includes(draft.status)) {
    throw Object.assign(
      new Error(`Cannot publish draft in status ${draft.status}`),
      { status: 400, code: "INVALID_STATUS" }
    );
  }

  // Pre-publish media validation
  const mediaValidation = validateDraftMedia(draft);
  if (mediaValidation.errors.length > 0) {
    throw Object.assign(
      new Error(mediaValidation.errors.join("; ")),
      { status: 422, code: "MEDIA_VALIDATION_FAILED", errors: mediaValidation.errors, warnings: mediaValidation.warnings }
    );
  }

  // Append warnings to draft (non-blocking)
  if (mediaValidation.warnings.length > 0) {
    const existingWarnings = Array.isArray(draft.warnings) ? draft.warnings : [];
    const newWarnings = mediaValidation.warnings.filter((w) => !existingWarnings.includes(w));
    if (newWarnings.length > 0) {
      await prisma.draft.update({
        where: { id: draftId },
        data: { warnings: [...existingWarnings, ...newWarnings] },
      }).catch(() => {});
    }
  }

  // Stamp an idempotency key on first attempt. Use a conditional updateMany
  // so two near-simultaneous publish clicks can't each generate a key and
  // race past the earlier short-circuit — only the row where idempotencyKey
  // is NULL gets stamped.
  let workingDraft = draft;
  if (!workingDraft.idempotencyKey) {
    await prisma.draft.updateMany({
      where: { id: draftId, idempotencyKey: null },
      data: { idempotencyKey: randomUUID() },
    });
    // Re-read the idempotency key without the heavy include — everything
    // else on `draft` is still current.
    const stamped = await prisma.draft.findUnique({
      where: { id: draftId },
      select: { idempotencyKey: true },
    });
    workingDraft = { ...draft, idempotencyKey: stamped?.idempotencyKey ?? null };
  }

  // Resolve the connection (decrypted tokens for adapter use)
  let connection = await getConnectionForAdapter(
    workingDraft.clientId,
    workingDraft.channel
  );

  // Auto-refresh token if near expiry
  if (connection) {
    try {
      connection = await ensureValidAccessToken(connection);
    } catch {
      // Token refresh failed — connection is now NEEDS_RECONNECT.
      // Fall through to the existing status !== CONNECTED check below.
    }
  }

  // LOCAL FALLBACK: no connection -> Phase 1 behavior with a warning
  if (!connection || connection.status !== "CONNECTED") {
    const warnings = Array.isArray(workingDraft.warnings)
      ? workingDraft.warnings
      : [];
    // Scheduled publishes must go through a valid connection — don't silently
    // publish locally when the worker fires and no connection exists.
    if (source === "scheduled") {
      throw Object.assign(
        new Error(
          `Scheduled publish requires a valid connection (status: ${connection?.status ?? "none"})`
        ),
        {
          status: 422,
          code: "SCHEDULED_PUBLISH_NO_CONNECTION",
          connectionStatus: connection?.status ?? null,
        }
      );
    }

    const updated = await transitionDraft(draftId, "PUBLISHED", actorSub, {
      publishedAt: new Date(),
      publishSource: source,
      warnings: [
        ...warnings.filter((w) => w !== "no_connection_published_locally"),
        "no_connection_published_locally",
      ],
    });
    return formatDraft(updated);
  }

  const adapter = getAdapterForChannel(workingDraft.channel);

  try {
    const { externalPostId, externalPostUrl } = await adapter.publishPost({
      draft: workingDraft,
      connection,
      client: workingDraft.client,
    });

    const updated = await transitionDraft(draftId, "PUBLISHED", actorSub, {
      publishedAt: new Date(),
      publishSource: source,
      externalPostId,
      externalPostUrl,
      publishError: null,
      publishAttempts: { increment: 1 },
      lastPublishAttemptAt: new Date(),
    });

    // Refresh lastValidatedAt on the connection — a successful publish is
    // the strongest possible credential validation. Fire-and-forget.
    updateConnectionStatus(workingDraft.clientId, workingDraft.channel, {
      lastValidatedAt: new Date(),
      lastError: null,
    }).catch(() => {});

    // Enqueue POST_PUBLISHED notification
    notifyDraftOwner(workingDraft, "POST_PUBLISHED", {
      channel: workingDraft.channel,
      body: workingDraft.body,
      externalPostUrl,
      clientId: workingDraft.clientId,
    });

    // Enqueue metrics sync with 5-minute delay
    import("../metricsSyncService.js")
      .then(({ enqueuePostPublishSync }) =>
        enqueuePostPublishSync(draftId)
      )
      .catch(() => {});

    // Update data item + blueprint performance stats
    import("../dataAnalytics.service.js")
      .then(({ updatePerformanceForDraft }) =>
        updatePerformanceForDraft(draftId)
      )
      .catch(() => {});

    return formatDraft(updated);
  } catch (err) {
    // Draft STAYS in APPROVED/SCHEDULED. Record the failure details so the
    // user can see them in the queue and retry.
    await prisma.draft
      .update({
        where: { id: draftId },
        data: {
          publishAttempts: { increment: 1 },
          lastPublishAttemptAt: new Date(),
          publishError: err?.message ?? "Unknown publish error",
        },
      })
      .catch(() => {});

    // Mark the connection as ERROR so the Channels tab shows the issue —
    // but only for auth-ish failures.
    const metaCode = err?.metaError?.code;
    const isAuthish =
      err?.status === 401 ||
      err?.status === 403 ||
      err?.code === "META_OAUTH_FAILED" ||
      metaCode === 190 ||
      metaCode === 102;
    if (isAuthish) {
      await updateConnectionStatus(
        workingDraft.clientId,
        workingDraft.channel,
        { status: "ERROR", lastError: err?.message ?? "Unknown error" }
      ).catch(() => {});
    }

    // Enqueue POST_FAILED notification
    notifyDraftOwner(workingDraft, "POST_FAILED", {
      channel: workingDraft.channel,
      body: workingDraft.body,
      error: err?.message ?? "Unknown error",
      clientId: workingDraft.clientId,
    });

    // Re-throw so the route handler returns a proper error response.
    throw err;
  }
}
