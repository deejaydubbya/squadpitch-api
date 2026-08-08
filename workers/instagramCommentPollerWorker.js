// BullMQ worker for Instagram comment polling.
//
// Prompt 01 removed the Meta webhook receiver in favor of polling so
// Inbox comment intake doesn't depend on a webhook surface Meta may
// revoke between App Review submissions. This worker fires on the
// META_COMMENT_POLLING_INTERVAL_MINUTES schedule (default 15 min)
// and walks every CONNECTED INSTAGRAM ChannelConnection, enumerating
// each workspace's recently-published IG media and fetching the
// comment thread. The ingestion layer is idempotent on comment id
// so re-fetching is safe.
//
// Concurrency: 1 — IG's per-token quota is shared across the
// process. Spreading across workers wouldn't buy anything; the poll
// interval is the right knob.
//
// Gating: the SCHEDULED recurring tick honors META_COMMENT_POLLING_ENABLED
// (default false). The Worker itself ALWAYS starts when Redis is
// available — otherwise manual `poll-connection` jobs enqueued by
// the /sync-comments route would sit in Redis with no consumer
// (originally broken 2026-06-02: route returned 202 but nothing ran).
// Only the recurring `poll-instagram-comments-repeat` job is gated.

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { env } from "../config/env.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";

const QUEUE_NAME = "sp-instagram-comments-poll";
const POLL_INTERVAL_MS = env.META_COMMENT_POLLING_INTERVAL_MINUTES * 60_000;

export function startInstagramCommentPollerWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[IG_COMMENT_POLLER] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));

  if (env.META_COMMENT_POLLING_ENABLED) {
    queue
      .add(
        "poll-instagram-comments",
        {},
        { repeat: { every: POLL_INTERVAL_MS }, jobId: "poll-instagram-comments-repeat" },
      )
      .catch((err) =>
        console.error("[IG_COMMENT_POLLER] Failed to add repeating job:", err.message),
      );
    console.log(
      `[IG_COMMENT_POLLER] Scheduled polling enabled (interval=${env.META_COMMENT_POLLING_INTERVAL_MINUTES}m)`,
    );
  } else {
    console.warn(
      "[IG_COMMENT_POLLER] Scheduled polling disabled — META_COMMENT_POLLING_ENABLED=false. Manual /sync-comments still works.",
    );
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "poll-instagram-comments") {
        const { pollInstagramCommentsForAllConnections } = await import(
          "../domains/inbox/inbox.instagramCommentPoller.service.js"
        );
        await pollInstagramCommentsForAllConnections({ limit: 50 });
      } else if (job.name === "poll-connection") {
        const { pollInstagramCommentsForConnection } = await import(
          "../domains/inbox/inbox.instagramCommentPoller.service.js"
        );
        const { prisma } = await import("../prisma.js");
        const conn = await prisma.channelConnection.findUnique({
          where: { id: job.data.connectionId },
        });
        if (!conn) {
          console.warn("[IG_COMMENT_POLLER] poll-connection job: connection not found", {
            connectionId: job.data.connectionId,
          });
          return;
        }
        // Single-connection manual sync from /sync-comments. Surface
        // the result inline so an "I clicked Sync and nothing
        // happened" debugging session can see exactly what ran
        // (or what skipped, and why).
        console.log("[IG_COMMENT_POLLER] poll-connection job start", {
          connectionId: conn.id,
          clientId: conn.clientId,
          externalAccountId: conn.externalAccountId,
        });
        const summary = await pollInstagramCommentsForConnection(conn);
        console.log("[IG_COMMENT_POLLER] poll-connection job done", {
          connectionId: conn.id,
          mediaChecked: summary.mediaChecked,
          commentsFetched: summary.commentsFetched,
          messagesCreated: summary.messagesCreated,
          conversationsCreated: summary.conversationsCreated,
          duplicatesSkipped: summary.duplicatesSkipped,
          errorsCount: summary.errors.length,
          errors: summary.errors,
        });
      }
    },
    { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS },
  );

  worker.on("error", (err) => {
    console.error("[IG_COMMENT_POLLER] Worker error:", err.message);
  });

  console.log("[IG_COMMENT_POLLER] Worker started (processing manual + scheduled jobs)");

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
export async function enqueueInstagramCommentPollForConnection(connectionId) {
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
