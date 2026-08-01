// Publishing orchestrator.
//
// Single entry point used by the POST /drafts/:id/publish route. Always
// publishes via a channel adapter — there is no longer a local-only
// fallback.
//
// Semantics:
//  - no connection (or status != CONNECTED) -> 422 CHANNEL_NOT_CONNECTED, draft unchanged
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
import {
  ensureValidAccessToken,
  refreshConnectionToken,
} from "../tokenRefreshService.js";
import { withPublishTimeout } from "./publishTimeout.js";

// ── Adapter error classification ────────────────────────────────────────
//
// Public, distinct error codes the route handler and worker can branch on.
// Listed here so adding a new one is a single-file change.
//
//   CHANNEL_NOT_CONNECTED   no ChannelConnection row at all
//   TOKEN_EXPIRED           ChannelConnection exists but status is EXPIRED /
//                           NEEDS_RECONNECT — user must re-auth
//   PROVIDER_AUTH_FAILED    adapter rejected with 401/403 (token revoked
//                           upstream after we refreshed)
//   PROVIDER_TIMEOUT        adapter call exceeded PUBLISH_ADAPTER_TIMEOUT_MS
//   RATE_LIMITED            adapter returned 429 / Retry-After
//   VALIDATION_FAILED       adapter rejected with 400 for content/format
//   PROVIDER_NO_EXTERNAL_ID adapter resolved without an external post id
//                           (we refuse to mark PUBLISHED without proof)

const NO_RECONNECT_STATUSES = new Set(["CONNECTED"]);

/**
 * Wrap an adapter error with a stable `code` so downstream handlers and
 * UIs can branch on it. Mutates and returns the original Error so the
 * stack/message are preserved.
 */
function classifyAdapterError(err, channel) {
  if (!err) return err;
  // Preserve any already-tagged code (e.g., timeouts thrown by withPublishTimeout)
  if (err.code === "PROVIDER_TIMEOUT") return err;

  const status = err.status ?? err.statusCode ?? 0;
  const metaCode = err.metaError?.code;
  const isAuth =
    status === 401 ||
    status === 403 ||
    err.code === "META_OAUTH_FAILED" ||
    metaCode === 190 ||
    metaCode === 102;

  if (isAuth) {
    err.code = "PROVIDER_AUTH_FAILED";
    err.status = err.status ?? 401;
  } else if (status === 429 || err.code === "RATE_LIMITED") {
    err.code = "RATE_LIMITED";
    err.status = err.status ?? 429;
  } else if (status === 400) {
    err.code = "VALIDATION_FAILED";
    err.status = err.status ?? 400;
  } else if (!err.code) {
    // Unknown — leave the code unset so the worker classifier treats it
    // as a transient retry candidate.
  }

  err.channel = err.channel ?? channel;
  return err;
}

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

  // Content validation — cannot publish empty/blank content
  const bodyText = (draft.body ?? "").trim();
  if (!bodyText && !draft.mediaUrl) {
    throw Object.assign(
      new Error("Cannot publish a post with no content and no media"),
      { status: 422, code: "EMPTY_CONTENT" }
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

  // No connection (or token not valid) -> hard 422.
  // We never silently mark a draft as PUBLISHED when nothing was actually
  // delivered to the external channel. Both manual and scheduled paths
  // must surface this and let the user reconnect the channel.
  if (!connection) {
    throw Object.assign(
      new Error(
        `${workingDraft.channel} is not connected for this workspace. Connect the channel before publishing.`
      ),
      {
        status: 422,
        code: "CHANNEL_NOT_CONNECTED",
        channel: workingDraft.channel,
        clientId: workingDraft.clientId,
        connectionStatus: null,
      }
    );
  }
  if (!NO_RECONNECT_STATUSES.has(connection.status)) {
    // Connection exists but the token is no longer good. Distinct from the
    // never-connected case so the UI can prompt the user to reconnect
    // (rather than connect from scratch).
    throw Object.assign(
      new Error(
        `${workingDraft.channel} access has expired. Reconnect the channel to publish.`
      ),
      {
        status: 422,
        code: "TOKEN_EXPIRED",
        channel: workingDraft.channel,
        clientId: workingDraft.clientId,
        connectionStatus: connection.status,
      }
    );
  }

  const adapter = getAdapterForChannel(workingDraft.channel);

  try {
    // Bound the adapter call with a hard timeout. On timeout, the helper
    // throws PROVIDER_TIMEOUT (status 504) which the worker classifies as
    // transient and retries.
    const invokeAdapter = (activeConnection) =>
      withPublishTimeout(
        adapter.publishPost({
          draft: workingDraft,
          connection: activeConnection,
          client: workingDraft.client,
        }),
        { channel: workingDraft.channel },
      );

    let publishResult;
    try {
      publishResult = await invokeAdapter(connection);
    } catch (firstError) {
      // A Pinterest access token can be revoked before its recorded expiry.
      // Refresh once, then retry the same idempotency-guarded publish. Never
      // recurse or retry a second time, which avoids duplicate/infinite loops.
      if (
        workingDraft.channel !== "PINTEREST" ||
        firstError?.code !== "AUTH_FAILED"
      ) {
        throw firstError;
      }
      connection = await refreshConnectionToken(connection);
      publishResult = await invokeAdapter(connection);
    }

    const { externalPostId, externalPostUrl } = publishResult;

    // Refuse to flip the draft to PUBLISHED without proof of delivery.
    // Every channel adapter we ship returns a non-empty externalPostId on
    // success (TikTok returns publish_id even when no permalink is
    // available). If we got nothing back, treat it as a transient failure
    // and let the worker retry.
    if (!externalPostId) {
      throw Object.assign(
        new Error(
          `${workingDraft.channel} adapter returned no external post ID — refusing to mark PUBLISHED.`
        ),
        {
          status: 502,
          code: "PROVIDER_NO_EXTERNAL_ID",
          channel: workingDraft.channel,
        }
      );
    }

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
      .then(({ enqueuePostPublishSync, enqueueTiktokVideoIdResolution }) => {
        enqueuePostPublishSync(draftId);
        // TikTok stores publish_id (upload-session handle) as
        // externalPostId. Kick off the resolver so it polls TikTok for
        // the final video_id and overwrites externalPostId before the
        // 5-minute metrics-sync delay finishes. See
        // publishing/tiktokVideoIdResolver.js.
        if (workingDraft.channel === "TIKTOK") {
          enqueueTiktokVideoIdResolution(draftId);
        }
      })
      .catch(() => {});

    // Update data item + blueprint performance stats
    import("../dataAnalytics.service.js")
      .then(({ updatePerformanceForDraft }) =>
        updatePerformanceForDraft(draftId)
      )
      .catch(() => {});

    return formatDraft(updated);
  } catch (err) {
    // Tag the error with a stable code (PROVIDER_AUTH_FAILED / RATE_LIMITED /
    // VALIDATION_FAILED / PROVIDER_TIMEOUT / …) so route handlers, the
    // worker classifier, and the customer UI can all branch on it cleanly.
    classifyAdapterError(err, workingDraft.channel);

    // Draft STAYS in APPROVED/SCHEDULED. Record the failure details so the
    // user can see them in the queue and retry. We persist a short
    // human-readable error and the typed code so the planner UI can pick
    // the right friendly message + action.
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
    // but only for auth-ish failures (now centralised under PROVIDER_AUTH_FAILED).
    if (err?.code === "PROVIDER_AUTH_FAILED") {
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
      errorCode: err?.code ?? null,
      clientId: workingDraft.clientId,
    });

    // Re-throw so the route handler returns a proper error response.
    throw err;
  }
}
