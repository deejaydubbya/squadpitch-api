// BullMQ worker for Facebook Page comment polling.
//
// Prompt 01 removed the Meta webhook receiver in favor of polling so
// Inbox comment intake doesn't depend on a webhook surface Meta may
// revoke between App Review submissions. This worker fires on the
// META_COMMENT_POLLING_INTERVAL_MINUTES schedule (default 15 min)
// and walks every CONNECTED FACEBOOK ChannelConnection, enumerating
// each workspace's recently-published Facebook posts and fetching
// the comment thread. The ingestion layer is idempotent on comment
// id so re-fetching is safe.
//
// Concurrency: 1 — Facebook's per-token quota is shared across the
// process. Spreading across workers wouldn't buy anything; the poll
// interval is the right knob.
//
// Gating: the SCHEDULED recurring tick honors META_COMMENT_POLLING_ENABLED
// (default false). The Worker itself ALWAYS starts when Redis is
// available — otherwise manual `poll-connection` jobs enqueued by
// the /sync-comments route would sit in Redis with no consumer
// (originally broken 2026-06-02: route returned 202 but nothing ran).
// Only the recurring `poll-facebook-comments-repeat` job is gated.

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { env } from "../config/env.js";

const QUEUE_NAME = "sp-facebook-comments-poll";
const POLL_INTERVAL_MS = env.META_COMMENT_POLLING_INTERVAL_MINUTES * 60_000;

export function startFacebookCommentPollerWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[FB_COMMENT_POLLER] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  if (env.META_COMMENT_POLLING_ENABLED) {
    queue
      .add(
        "poll-facebook-comments",
        {},
        { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-facebook-comments-repeat" },
      )
      .catch((err) =>
        console.error("[FB_COMMENT_POLLER] Failed to add repeating job:", err.message),
      );
    console.log(
      `[FB_COMMENT_POLLER] Scheduled polling enabled (interval=${env.META_COMMENT_POLLING_INTERVAL_MINUTES}m)`,
    );
  } else {
    console.warn(
      "[FB_COMMENT_POLLER] Scheduled polling disabled — META_COMMENT_POLLING_ENABLED=false. Manual /sync-comments still works.",
    );
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "poll-facebook-comments") {
        const { pollFacebookCommentsForAllConnections } = await import(
          "../domains/inbox/inbox.facebookCommentPoller.service.js"
        );
        await pollFacebookCommentsForAllConnections({ limit: 50 });
      } else if (job.name === "poll-connection") {
        const { pollFacebookCommentsForConnection } = await import(
          "../domains/inbox/inbox.facebookCommentPoller.service.js"
        );
        const { prisma } = await import("../prisma.js");
        const conn = await prisma.channelConnection.findUnique({
          where: { id: job.data.connectionId },
        });
        if (conn) {
          await pollFacebookCommentsForConnection(conn);
        }
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("error", (err) => {
    console.error("[FB_COMMENT_POLLER] Worker error:", err.message);
  });

  console.log("[FB_COMMENT_POLLER] Worker started (processing manual + scheduled jobs)");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}

// Helper for the manual "Sync now" route — adds a one-shot
// poll-connection job rather than waiting for the next tick. The
// manual path is NOT gated on META_COMMENT_POLLING_ENABLED, so we
// still need a queue available; if Redis is down we throw with
// QUEUE_UNAVAILABLE so the route falls back to inline execution.
export async function enqueueFacebookCommentPollForConnection(connectionId) {
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
