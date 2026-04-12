// BullMQ worker for periodic metrics syncing.
//
// Pattern: follows scheduledPublishWorker.js
// - Repeating job: `poll-metrics` every 5 minutes
// - One-off job: `sync-single` (triggered post-publish with delay)
// - Batch size: 20 per tick
// - Concurrency: 1

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import {
  syncMetricsForDraft,
  getEligibleDraftsForSync,
} from "../domains/studio/metricsSyncService.js";
import { getAnalyticsRecalcQueue } from "../lib/queues.js";

const QUEUE_NAME = "sp-metrics-sync";
const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const BATCH_SIZE = 20;

// ── Error Classification ────────────────────────────────────────────

function classifyError(err) {
  if (err?.code === "AUTH_FAILED") return "auth";
  if (err?.transient) return "transient";
  return "permanent";
}

// ── Batch Tick ──────────────────────────────────────────────────────

async function processBatchTick() {
  const start = Date.now();
  const drafts = await getEligibleDraftsForSync({ batchSize: BATCH_SIZE });

  if (drafts.length === 0) return;

  let success = 0;
  let fail = 0;
  let skip = 0;

  for (const draft of drafts) {
    try {
      const result = await syncMetricsForDraft(draft.id);
      if (result.synced) {
        success++;
      } else {
        skip++;
      }
    } catch (err) {
      const kind = classifyError(err);
      if (kind === "auth") {
        // Auth failure — skip this draft, don't retry this tick
        console.warn(
          `[METRICS_SYNC] AUTH_FAILED for draft ${draft.id} (${draft.channel}): ${err.message}`
        );
        skip++;
      } else if (kind === "transient") {
        // Transient — will be retried next tick
        fail++;
      } else {
        // Permanent — log and move on
        console.error(
          `[METRICS_SYNC] Permanent error for draft ${draft.id}: ${err.message}`
        );
        fail++;
      }
    }
  }

  const elapsed = Date.now() - start;
  console.log(
    `[METRICS_SYNC] Tick complete: ${success} synced, ${fail} failed, ${skip} skipped (${elapsed}ms)`
  );

  // Trigger workspace analytics recalc for affected clients
  if (success > 0) {
    const uniqueClientIds = [...new Set(drafts.map((d) => d.clientId))];
    const recalcQueue = getAnalyticsRecalcQueue();
    if (recalcQueue) {
      for (const clientId of uniqueClientIds) {
        recalcQueue
          .add("recalc-client", { clientId }, { jobId: `recalc-${clientId}-${Date.now()}` })
          .catch(() => {});
      }
    }
  }
}

// ── Single-Draft Sync ───────────────────────────────────────────────

async function processSingleSync(draftId) {
  try {
    const result = await syncMetricsForDraft(draftId);
    console.log(
      `[METRICS_SYNC] Single sync for ${draftId}: ${result.synced ? "synced" : result.reason}`
    );
  } catch (err) {
    console.error(
      `[METRICS_SYNC] Single sync error for ${draftId}: ${err.message}`
    );
  }
}

// ── Worker Entry Point ──────────────────────────────────────────────

export function startMetricsSyncWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[METRICS_SYNC] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  // Add repeating poll job (upsert by jobId)
  queue
    .add(
      "poll-metrics",
      {},
      { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-metrics-repeat" }
    )
    .catch((err) =>
      console.error("[METRICS_SYNC] Failed to add repeating job:", err.message)
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "poll-metrics") {
        await processBatchTick();
      } else if (job.name === "sync-single") {
        await processSingleSync(job.data.draftId);
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("error", (err) => {
    console.error("[METRICS_SYNC] Worker error:", err.message);
  });

  console.log("[METRICS_SYNC] Worker started");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
