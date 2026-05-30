// BullMQ worker for Threads reply polling.
//
// Threads' /conversation endpoint must be polled — the Threads
// Webhook product doesn't cover reply ingestion at the time of
// writing. This worker fires on a 15-minute interval and walks
// every CONNECTED Threads ChannelConnection, enumerating each
// workspace's recently-published Threads posts and fetching the
// reply tree. The ingestion layer is idempotent on reply id so
// re-fetching is safe.
//
// Concurrency: 1 — Threads' per-token quota is shared across the
// process. The poll interval is the right knob.

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";

const QUEUE_NAME = "sp-threads-reply-poll";
const POLL_INTERVAL_MS = 15 * 60_000; // 15 minutes

export function startThreadsReplyPollerWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[TH_REPLY_POLLER] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  queue
    .add(
      "poll-threads-replies",
      {},
      { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-threads-replies-repeat" },
    )
    .catch((err) =>
      console.error("[TH_REPLY_POLLER] Failed to add repeating job:", err.message),
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "poll-threads-replies") {
        const { runThreadsReplyPollTick } = await import(
          "../domains/inbox/threadsReplyPoller.service.js"
        );
        await runThreadsReplyPollTick({ batchSize: 50 });
      } else if (job.name === "poll-connection") {
        const { pollThreadsRepliesForConnection } = await import(
          "../domains/inbox/threadsReplyPoller.service.js"
        );
        const { prisma } = await import("../prisma.js");
        const conn = await prisma.channelConnection.findUnique({
          where: { id: job.data.connectionId },
        });
        if (conn) {
          await pollThreadsRepliesForConnection(conn);
        }
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("error", (err) => {
    console.error("[TH_REPLY_POLLER] Worker error:", err.message);
  });

  console.log("[TH_REPLY_POLLER] Worker started (interval=15m)");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}

// Helper for the admin "Sync now" route.
export async function enqueueThreadsReplyPollForConnection(connectionId) {
  const connection = getRedisConnection();
  if (!connection) {
    throw Object.assign(new Error("Redis is not configured; cannot enqueue sync"), {
      status: 503,
      code: "QUEUE_UNAVAILABLE",
    });
  }
  const queue = new Queue(QUEUE_NAME, { connection });
  try {
    await queue.add(
      "poll-connection",
      { connectionId },
      { removeOnComplete: true, removeOnFail: 50 },
    );
  } finally {
    await queue.close();
  }
}
