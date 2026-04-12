// BullMQ worker for daily insights refresh + snapshot creation.
//
// - Repeating job: `refresh-insights` every 24 hours
// - Concurrency: 1

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import {
  getClientsNeedingInsightsRefresh,
  createDailySnapshot,
} from "../domains/studio/workspaceAnalytics.service.js";
import { backfillClientInsights } from "../domains/studio/normalization.service.js";

const QUEUE_NAME = "sp-insights-refresh";
const POLL_INTERVAL_MS = 24 * 60 * 60_000; // 24 hours

// ── Refresh Tick ───────────────────────────────────────────────────

async function processRefreshTick() {
  const clientIds = await getClientsNeedingInsightsRefresh();
  if (clientIds.length === 0) {
    console.log("[INSIGHTS_REFRESH] No clients need refresh");
    return;
  }

  let success = 0;
  let fail = 0;

  for (const clientId of clientIds) {
    try {
      await backfillClientInsights(clientId);
      await createDailySnapshot(clientId);
      success++;
    } catch (err) {
      console.error(`[INSIGHTS_REFRESH] Error for client ${clientId}: ${err.message}`);
      fail++;
    }
  }

  console.log(
    `[INSIGHTS_REFRESH] Refresh complete: ${success} refreshed, ${fail} failed out of ${clientIds.length}`
  );
}

// ── Worker Entry Point ─────────────────────────────────────────────

export function startRefreshInsightsWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[INSIGHTS_REFRESH] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  // Add repeating job
  queue
    .add(
      "refresh-insights",
      {},
      { repeat: { every: POLL_INTERVAL_MS }, jobId: "refresh-insights-repeat" }
    )
    .catch((err) =>
      console.error("[INSIGHTS_REFRESH] Failed to add repeating job:", err.message)
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "refresh-insights") {
        await processRefreshTick();
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("error", (err) => {
    console.error("[INSIGHTS_REFRESH] Worker error:", err.message);
  });

  console.log("[INSIGHTS_REFRESH] Worker started");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
