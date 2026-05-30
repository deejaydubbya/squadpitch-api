// BullMQ worker for Google Business Profile review polling.
//
// GBP has no webhook for reviews — Google requires polling. This
// worker fires on a 10-minute interval and walks every CONNECTED
// GBP ChannelConnection that has finished the location picker,
// fetching the latest 50 reviews per location and dispatching
// each to ingestGbpReview (idempotent on review.name).
//
// Concurrency: 1 — Google's per-token quota is shared across the
// process, so spreading across more concurrent workers wouldn't
// buy us anything. The poll interval is the right knob.

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";

const QUEUE_NAME = "sp-gbp-review-poll";
const POLL_INTERVAL_MS = 10 * 60_000; // 10 minutes

export function startGbpReviewPollerWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[GBP_POLLER] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  // Upsert the repeating poll job.
  queue
    .add(
      "poll-gbp-reviews",
      {},
      { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-gbp-reviews-repeat" },
    )
    .catch((err) =>
      console.error("[GBP_POLLER] Failed to add repeating job:", err.message),
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "poll-gbp-reviews") {
        const { runGbpReviewPollTick } = await import(
          "../domains/inbox/gbpReviewPoller.service.js"
        );
        await runGbpReviewPollTick({ batchSize: 50 });
      } else if (job.name === "poll-connection") {
        const { pollGbpReviewsForConnection } = await import(
          "../domains/inbox/gbpReviewPoller.service.js"
        );
        const { prisma } = await import("../prisma.js");
        const conn = await prisma.channelConnection.findUnique({
          where: { id: job.data.connectionId },
        });
        if (conn) {
          await pollGbpReviewsForConnection(conn);
        }
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("error", (err) => {
    console.error("[GBP_POLLER] Worker error:", err.message);
  });

  console.log("[GBP_POLLER] Worker started (interval=10m)");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
