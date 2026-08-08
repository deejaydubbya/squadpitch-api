// BullMQ worker for the Autopilot evaluator.
//
// Phase 5 of docs/AUTOPILOT_PRODUCT_AUDIT.md.
//
// Fires every AUTOPILOT_SCHEDULER_INTERVAL_MIN minutes (default
// 6 hours) and walks every CONNECTED workspace with autopilot
// enabled, running runScheduledAutopilot per workspace. Each
// per-workspace evaluation writes its own AutopilotRun row via
// the evaluator's recordRun wrapper.
//
// Gated on AUTOPILOT_SCHEDULER_ENABLED — defaults false so a
// fresh deploy doesn't start a fleet-wide eval on day one. To
// enable in prod: set AUTOPILOT_SCHEDULER_ENABLED=true on Fly.
//
// Concurrency: 1. Evaluator work is mostly DB reads + a few
// upserts per workspace, but the goal here is predictability
// (no overlapping fleet evals), not throughput.

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { env } from "../config/env.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";

const QUEUE_NAME = "sp-autopilot-evaluator";

export function startAutopilotEvaluatorWorker() {
  if (!env.AUTOPILOT_SCHEDULER_ENABLED) {
    console.log("[AUTOPILOT_SCHED] disabled (AUTOPILOT_SCHEDULER_ENABLED=false)");
    return { close: async () => {} };
  }
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[AUTOPILOT_SCHED] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const intervalMin = Math.max(env.AUTOPILOT_SCHEDULER_INTERVAL_MIN ?? 360, 5);
  const intervalMs = intervalMin * 60_000;

  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));

  // Upsert the repeating tick job.
  queue
    .add(
      "evaluate-all",
      {},
      {
        repeat: { every: intervalMs },
        jobId: "evaluate-all-repeat",
      },
    )
    .catch((err) =>
      console.error("[AUTOPILOT_SCHED] Failed to add repeating job:", err.message),
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== "evaluate-all") return;
      const { evaluateAllAutopilotWorkspaces } = await import(
        "../domains/studio/autopilot.service.js"
      );
      try {
        const result = await evaluateAllAutopilotWorkspaces();
        console.log("[AUTOPILOT_SCHED] tick complete:", {
          evaluated: result.evaluated,
          generatedTotal: result.generatedTotal,
        });
      } catch (err) {
        console.error("[AUTOPILOT_SCHED] tick threw:", err?.message);
      }
    },
    { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS },
  );

  worker.on("error", (err) => {
    console.error("[AUTOPILOT_SCHED] Worker error:", err.message);
  });

  console.log(`[AUTOPILOT_SCHED] Worker started (interval=${intervalMin}m)`);

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
