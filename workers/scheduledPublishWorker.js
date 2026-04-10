import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { prisma } from "../prisma.js";
import { publishDraft } from "../domains/studio/publishing/publishingService.js";
import { transitionDraft } from "../domains/studio/draftWorkflow.service.js";

const QUEUE_NAME = "sp-scheduled-publish";
const POLL_INTERVAL_MS = 60_000;
const MAX_PUBLISH_ATTEMPTS = 5;
const BATCH_CAP = 50;
const ACTOR_SUB = "system|sp-scheduled-worker";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const PERMANENT_CODES = new Set([
  "NO_MEDIA",
  "CAPTION_TOO_LONG",
  "CONNECTION_INVALID",
  "INVALID_STATUS",
  "DRAFT_NOT_FOUND",
]);

function classifyError(err) {
  const code = err?.code ?? "";
  const status = err?.status ?? 0;
  const metaCode = err?.metaError?.code;

  // Permanent — content / config problems that won't self-heal
  if (PERMANENT_CODES.has(code)) return "permanent";
  if (status === 400 && !isAuthError(status, code, metaCode)) return "permanent";

  // Connection — auth / credential problems
  if (isAuthError(status, code, metaCode)) return "connection";
  if (code === "SCHEDULED_PUBLISH_NO_CONNECTION") return "connection";

  // Everything else is transient (5xx, network, rate-limit, unknown)
  return "transient";
}

function isAuthError(status, code, metaCode) {
  return (
    status === 401 ||
    status === 403 ||
    code === "META_OAUTH_FAILED" ||
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
      client: { status: "ACTIVE" },
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
      client: { status: "ACTIVE" },
    },
  });

  const backlog = totalDue > BATCH_CAP ? totalDue - BATCH_CAP : 0;
  const backlogMsg = backlog > 0 ? ` [WARNING: backlog=${backlog}]` : "";
  console.log(
    `[SP-WORKER] Tick start: ${dueDrafts.length} draft(s) due${backlogMsg}`
  );

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
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

export function startScheduledPublishWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[SP-WORKER] No Redis — scheduled publish worker disabled");
    return null;
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  // Seed the repeating job (idempotent — BullMQ deduplicates by repeat key)
  queue.add(
    "poll-scheduled-drafts",
    {},
    { repeat: { every: POLL_INTERVAL_MS } }
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await processTick();
    },
    { connection, concurrency: 1 }
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
