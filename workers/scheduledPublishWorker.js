import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";
import { findDuplicateSchedulerKeys } from "../lib/repeatScheduler.js";
import { prisma } from "../prisma.js";
import { publishDraft } from "../domains/studio/publishing/publishingService.js";
import { transitionDraft } from "../domains/studio/draftWorkflow.service.js";
import { sendOpsAlert } from "../lib/opsAlert.js";

const QUEUE_NAME = "sp-scheduled-publish";
const POLL_INTERVAL_MS = 60_000;
const MAX_PUBLISH_ATTEMPTS = 5;
const BATCH_CAP = 50;
const ACTOR_SUB = "system|sp-scheduled-worker";

// Alert thresholds. These are deliberately loose — sendOpsAlert dedupes for
// 10 minutes per `key`, so we don't need extra hysteresis here.
const ALERT_BACKLOG_THRESHOLD = 25;        // beyond BATCH_CAP
const ALERT_FAIL_RATE_THRESHOLD = 0.5;     // 50% of a tick failed permanently
const ALERT_FAIL_MIN_COUNT = 3;            // ignore tiny ticks

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

// Permanent: content/config the user must fix; retrying won't help.
const PERMANENT_CODES = new Set([
  "NO_MEDIA",
  "CAPTION_TOO_LONG",
  "CONNECTION_INVALID",
  "INVALID_STATUS",
  "DRAFT_NOT_FOUND",
  "VALIDATION_FAILED",
]);

// Connection: token/auth issue — user must reconnect the channel before
// any further attempt will succeed.
const CONNECTION_CODES = new Set([
  "CHANNEL_NOT_CONNECTED",
  "TOKEN_EXPIRED",
  "PROVIDER_AUTH_FAILED",
  "META_OAUTH_FAILED",
  // Legacy code from the previous publishingService — keep recognising it
  // so any in-flight retries from before the upgrade still classify right.
  "SCHEDULED_PUBLISH_NO_CONNECTION",
]);

function classifyError(err) {
  const code = err?.code ?? "";
  const status = err?.status ?? 0;
  const metaCode = err?.metaError?.code;

  // Permanent — content / config problems that won't self-heal
  if (PERMANENT_CODES.has(code)) return "permanent";
  if (status === 400 && !isAuthError(status, code, metaCode)) return "permanent";

  // Connection — auth / credential problems
  if (CONNECTION_CODES.has(code)) return "connection";
  if (isAuthError(status, code, metaCode)) return "connection";

  // Everything else is transient (PROVIDER_TIMEOUT, RATE_LIMITED, 5xx,
  // network, PROVIDER_NO_EXTERNAL_ID, unknown).
  return "transient";
}

function isAuthError(status, code, metaCode) {
  return (
    status === 401 ||
    status === 403 ||
    code === "META_OAUTH_FAILED" ||
    code === "PROVIDER_AUTH_FAILED" ||
    metaCode === 190 ||
    metaCode === 102
  );
}

// ---------------------------------------------------------------------------
// Helpers: recordSkip, markFailed
// ---------------------------------------------------------------------------

async function recordSkip(draftId, reason) {
  await prisma.draft
    .update({
      where: { id: draftId },
      data: {
        publishAttempts: { increment: 1 },
        lastPublishAttemptAt: new Date(),
        publishError: reason,
      },
    })
    .catch(() => {});
}

async function markFailed(draftId, approverSub, reason) {
  try {
    await transitionDraft(
      draftId,
      "FAILED",
      ACTOR_SUB,
      {
        publishError: reason,
        lastPublishAttemptAt: new Date(),
      },
      `Scheduled publish failed: ${reason} (originally approved by ${approverSub})`
    );
  } catch (err) {
    // Transition may fail if draft was already moved — log and move on
    console.error(
      `[SP-WORKER] markFailed transition error draft=${draftId}:`,
      err?.message ?? err
    );
  }
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function processTick() {
  const now = new Date();

  // Query only drafts belonging to ACTIVE clients; include connections to
  // avoid N+1 lookups per draft.
  const dueDrafts = await prisma.draft.findMany({
    where: {
      status: "SCHEDULED",
      scheduledFor: { lte: now },
      client: { status: "ACTIVE", lifecycle: "CUSTOMER" },
    },
    select: {
      id: true,
      channel: true,
      clientId: true,
      createdBy: true,
      approvedBy: true,
      publishAttempts: true,
      client: {
        select: {
          connections: {
            select: { channel: true, status: true },
          },
        },
      },
    },
    orderBy: { scheduledFor: "asc" },
    take: BATCH_CAP,
  });

  if (dueDrafts.length === 0) return; // silent idle

  const totalDue = await prisma.draft.count({
    where: {
      status: "SCHEDULED",
      scheduledFor: { lte: now },
      client: { status: "ACTIVE", lifecycle: "CUSTOMER" },
    },
  });

  const backlog = totalDue > BATCH_CAP ? totalDue - BATCH_CAP : 0;
  const backlogMsg = backlog > 0 ? ` [WARNING: backlog=${backlog}]` : "";
  console.log(
    `[SP-WORKER] Tick start: ${dueDrafts.length} draft(s) due${backlogMsg}`
  );

  if (backlog >= ALERT_BACKLOG_THRESHOLD) {
    sendOpsAlert({
      key: "sp-scheduled-publish:backlog",
      severity: "warning",
      title: "Scheduled publish backlog growing",
      message: `${backlog} draft(s) past their scheduledFor are waiting beyond the per-tick batch cap (${BATCH_CAP}).`,
      context: { backlog, batchCap: BATCH_CAP, totalDue, queue: QUEUE_NAME },
    }).catch(() => {});
  }

  const tickStart = Date.now();
  let success = 0;
  let fail = 0;
  let skip = 0;

  for (const draft of dueDrafts) {
    const actorSub = draft.approvedBy ?? draft.createdBy;
    const attempts = draft.publishAttempts ?? 0;

    // -----------------------------------------------------------------------
    // Pre-check: connection status for the draft's channel
    // -----------------------------------------------------------------------
    const conn = draft.client.connections.find(
      (c) => c.channel === draft.channel
    );
    const connStatus = conn?.status ?? null;

    if (connStatus === "REVOKED") {
      await markFailed(draft.id, actorSub, `Connection REVOKED for ${draft.channel}`);
      console.log(
        `[SP-WORKER] draft=${draft.id} → FAILED (connection REVOKED)`
      );
      fail++;
      continue;
    }

    if (connStatus === "EXPIRED" || connStatus === "ERROR") {
      await recordSkip(draft.id, `Connection ${connStatus} for ${draft.channel}`);
      if (attempts + 1 >= MAX_PUBLISH_ATTEMPTS) {
        await markFailed(
          draft.id,
          actorSub,
          `Connection ${connStatus} after ${MAX_PUBLISH_ATTEMPTS} attempts`
        );
        console.log(
          `[SP-WORKER] draft=${draft.id} → FAILED (connection ${connStatus}, max retries)`
        );
        fail++;
      } else {
        console.log(
          `[SP-WORKER] draft=${draft.id} skipped (connection ${connStatus}, attempt ${attempts + 1}/${MAX_PUBLISH_ATTEMPTS})`
        );
        skip++;
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Attempt publish
    // -----------------------------------------------------------------------
    try {
      await publishDraft({ draftId: draft.id, actorSub, source: "scheduled" });
      console.log(`[SP-WORKER] draft=${draft.id} → PUBLISHED`);
      success++;
    } catch (err) {
      const category = classifyError(err);

      if (category === "permanent") {
        await markFailed(draft.id, actorSub, err?.message ?? "Unknown permanent error");
        console.log(
          `[SP-WORKER] draft=${draft.id} → FAILED (permanent, ${err?.code ?? err?.message})`
        );
        fail++;
      } else if (category === "connection") {
        // publishDraft already recorded publishError; check attempts
        if (attempts + 1 >= MAX_PUBLISH_ATTEMPTS) {
          await markFailed(
            draft.id,
            actorSub,
            `${err?.message ?? "Connection error"} after ${MAX_PUBLISH_ATTEMPTS} attempts`
          );
          console.log(
            `[SP-WORKER] draft=${draft.id} → FAILED (connection, max retries)`
          );
          fail++;
        } else {
          console.log(
            `[SP-WORKER] draft=${draft.id} skipped (connection error, attempt ${attempts + 1}/${MAX_PUBLISH_ATTEMPTS})`
          );
          skip++;
        }
      } else {
        // transient — publishDraft already incremented attempts
        if (attempts + 1 >= MAX_PUBLISH_ATTEMPTS) {
          await markFailed(
            draft.id,
            actorSub,
            `${err?.message ?? "Transient error"} after ${MAX_PUBLISH_ATTEMPTS} attempts`
          );
          console.log(
            `[SP-WORKER] draft=${draft.id} → FAILED (transient, max retries)`
          );
          fail++;
        } else {
          console.log(
            `[SP-WORKER] draft=${draft.id} retry later (transient, attempt ${attempts + 1}/${MAX_PUBLISH_ATTEMPTS})`
          );
          skip++;
        }
      }
    }
  }

  const elapsed = Date.now() - tickStart;
  console.log(
    `[SP-WORKER] Tick done in ${elapsed}ms: success=${success} fail=${fail} skip=${skip}`
  );

  // Failure-rate alert. Only fire when the tick was big enough that a
  // ratio is meaningful — we don't want a single fluky failure paging
  // anybody.
  const decided = success + fail;
  if (
    fail >= ALERT_FAIL_MIN_COUNT &&
    decided > 0 &&
    fail / decided >= ALERT_FAIL_RATE_THRESHOLD
  ) {
    sendOpsAlert({
      key: "sp-scheduled-publish:fail-rate",
      severity: "critical",
      title: "Scheduled publish failure rate is high",
      message: `${fail}/${decided} drafts marked FAILED in this tick.`,
      context: { success, fail, skip, decided, queue: QUEUE_NAME },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

export async function startScheduledPublishWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[SP-WORKER] No Redis — scheduled publish worker disabled");
    return null;
  }

  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));

  // Seed the repeating job (idempotent — BullMQ deduplicates by repeat key)
  const repeatJob = await queue.add(
    "poll-scheduled-drafts",
    {},
    {
      repeat: { every: POLL_INTERVAL_MS },
      jobId: "poll-scheduled-drafts-repeat",
    }
  );

  // Adding a jobId changes BullMQ's repeat key. Remove only older schedulers
  // for this exact job and cadence so a rollout cannot leave two ticks running
  // every minute. This is a startup-only reconciliation, not recurring work.
  const schedulers = await queue.getJobSchedulers(0, -1, true);
  const duplicateKeys = findDuplicateSchedulerKeys(schedulers, {
    keepKey: repeatJob.repeatJobKey,
    name: "poll-scheduled-drafts",
    every: POLL_INTERVAL_MS,
  });
  for (const schedulerKey of duplicateKeys) {
    await queue.removeJobScheduler(schedulerKey);
  }

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await processTick();
    },
    { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS }
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[SP-WORKER] poll tick ${job?.id} failed:`,
      err?.message ?? err
    );
  });

  worker.on("error", (err) => {
    console.error("[SP-WORKER] worker error:", err?.message ?? err);
  });

  console.log("[SP-WORKER] sp-scheduled-publish worker started");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
