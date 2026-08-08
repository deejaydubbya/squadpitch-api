// BullMQ worker for YouTube comment polling.
//
// YouTube has no webhook for comments — PubSubHubbub is upload-only.
// This worker fires on a 15-minute interval and walks every
// CONNECTED YouTube ChannelConnection that's completed OAuth,
// enumerating each workspace's recently-published videos and
// fetching the latest commentThreads pages. The ingestion layer
// is idempotent on comment id so re-fetching is safe.
//
// Concurrency: 1 — YouTube's per-project quota is shared across
// the process. Spreading across workers wouldn't buy anything;
// the poll interval is the right knob.

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";

const QUEUE_NAME = "sp-youtube-comment-poll";
const POLL_INTERVAL_MS = 15 * 60_000; // 15 minutes

export function startYouTubeCommentPollerWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[YT_COMMENT_POLLER] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));

  // Upsert the repeating poll job.
  queue
    .add(
      "poll-youtube-comments",
      {},
      { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-youtube-comments-repeat" },
    )
    .catch((err) =>
      console.error("[YT_COMMENT_POLLER] Failed to add repeating job:", err.message),
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "poll-youtube-comments") {
        const { runYouTubeCommentPollTick } = await import(
          "../domains/inbox/youtubeCommentPoller.service.js"
        );
        await runYouTubeCommentPollTick({ batchSize: 50 });
      } else if (job.name === "poll-connection") {
        const { pollYouTubeCommentsForConnection } = await import(
          "../domains/inbox/youtubeCommentPoller.service.js"
        );
        const { prisma } = await import("../prisma.js");
        const conn = await prisma.channelConnection.findUnique({
          where: { id: job.data.connectionId },
        });
        if (conn) {
          await pollYouTubeCommentsForConnection(conn);
        }
      }
    },
    { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS },
  );

  worker.on("error", (err) => {
    console.error("[YT_COMMENT_POLLER] Worker error:", err.message);
  });

  console.log("[YT_COMMENT_POLLER] Worker started (interval=15m)");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}

// Helper for the admin "Sync now" route — adds a one-shot
// poll-connection job rather than waiting for the next tick.
export async function enqueueYouTubeCommentPollForConnection(connectionId) {
  const connection = getRedisConnection();
  if (!connection) {
    throw Object.assign(new Error("Redis is not configured; cannot enqueue sync"), {
      status: 503,
      code: "QUEUE_UNAVAILABLE",
    });
  }
  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));
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
