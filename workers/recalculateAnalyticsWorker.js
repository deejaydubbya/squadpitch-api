// BullMQ worker for periodic workspace analytics recalculation.
//
// - Repeating job: `poll-recalc` every 30 minutes
// - One-off job: `recalc-client` (triggered after metric sync)
// - Concurrency: 1

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import {
  recalculateWorkspaceAnalytics,
  getClientsNeedingRecalculation,
} from "../domains/studio/workspaceAnalytics.service.js";

const QUEUE_NAME = "sp-analytics-recalc";
const POLL_INTERVAL_MS = 30 * 60_000; // 30 minutes

// ── Batch Recalc ───────────────────────────────────────────────────

async function processPollRecalc() {
  const clientIds = await getClientsNeedingRecalculation();
  if (clientIds.length === 0) return;

  let success = 0;
  let fail = 0;

  for (const clientId of clientIds) {
    try {
      await recalculateWorkspaceAnalytics(clientId);
      success++;
    } catch (err) {
      console.error(`[ANALYTICS_RECALC] Error for client ${clientId}: ${err.message}`);
      fail++;
    }
  }

  console.log(
    `[ANALYTICS_RECALC] Poll complete: ${success} recalculated, ${fail} failed out of ${clientIds.length}`
  );
}

// ── Single Client Recalc ────────────────────────────────────────────

async function processRecalcClient(clientId) {
  try {
    await recalculateWorkspaceAnalytics(clientId);
    console.log(`[ANALYTICS_RECALC] Recalculated for client ${clientId}`);
  } catch (err) {
    console.error(`[ANALYTICS_RECALC] Error for client ${clientId}: ${err.message}`);
  }
}

// ── Worker Entry Point ─────────────────────────────────────────────

export function startRecalculateAnalyticsWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[ANALYTICS_RECALC] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  // Add repeating poll job
  queue
    .add(
      "poll-recalc",
      {},
      { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-recalc-repeat" }
    )
    .catch((err) =>
      console.error("[ANALYTICS_RECALC] Failed to add repeating job:", err.message)
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "poll-recalc") {
        await processPollRecalc();
      } else if (job.name === "recalc-client") {
        await processRecalcClient(job.data.clientId);
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("error", (err) => {
    console.error("[ANALYTICS_RECALC] Worker error:", err.message);
  });

  console.log("[ANALYTICS_RECALC] Worker started");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
