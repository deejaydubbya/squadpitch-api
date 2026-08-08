// BullMQ worker for periodic metrics syncing.
//
// Pattern: follows scheduledPublishWorker.js
// - Repeating job: `poll-metrics` every 5 minutes
// - One-off job: `sync-single` (triggered post-publish with delay)
// - Batch size: 20 per tick
// - Concurrency: 1

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";
import {
  syncMetricsForDraft,
  getEligibleDraftsForSync,
  enqueueTiktokVideoIdResolution,
} from "../domains/studio/metricsSyncService.js";
import { resolveTiktokVideoId } from "../domains/studio/publishing/tiktokVideoIdResolver.js";
import { getAnalyticsRecalcQueue } from "../lib/queues.js";

// TikTok video_id resolution backoff. Most uploads complete within
// 30–60 seconds; user-inbox flow can take a few minutes. Cap total
// effort at ~10 minutes (1+2+4+8+16+32+64+128+256s ≈ 8m30s) before
// declaring permanent and giving up.
const TIKTOK_RESOLVE_MAX_ATTEMPTS = 8;
const TIKTOK_RESOLVE_BASE_DELAY_MS = 30_000;

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

// ── TikTok publish_id → video_id resolver ──────────────────────────
//
// One job per attempt. On still_processing or transient we re-enqueue
// the next attempt with exponential backoff up to the max. On
// already_resolved / newly_resolved / publish_failed / permanent we
// stop. If we hit the max attempts, the metrics sync will continue to
// return tiktok_video_id_missing (clear, non-silent failure).

async function processTiktokResolve({ draftId, attempt = 1 }) {
  let result;
  try {
    result = await resolveTiktokVideoId({ draftId });
  } catch (err) {
    console.error(
      `[METRICS_SYNC] tiktok-resolve error draftId=${draftId} attempt=${attempt}: ${err.message}`
    );
    return;
  }

  if (result.resolved) {
    console.log(
      `[METRICS_SYNC] tiktok-resolve done draftId=${draftId} status=${result.status} videoId=${result.videoId}`
    );
    // We just got the real video_id — nudge the metrics sync to pick
    // up actual counts on the next tick instead of waiting an hour for
    // the cooldown-driven sweep.
    return;
  }

  // Stop conditions: terminal or unrecoverable.
  if (
    result.status === "publish_failed" ||
    result.status === "permanent" ||
    result.status === "draft_not_found" ||
    result.status === "not_tiktok" ||
    result.status === "no_publish_id"
  ) {
    console.warn(
      `[METRICS_SYNC] tiktok-resolve giving up draftId=${draftId} status=${result.status}`
    );
    return;
  }

  // still_processing / transient / no_connection / token_refresh_failed
  // — try again with backoff.
  if (attempt >= TIKTOK_RESOLVE_MAX_ATTEMPTS) {
    console.warn(
      `[METRICS_SYNC] tiktok-resolve max attempts reached draftId=${draftId}`
    );
    return;
  }
  const nextDelay = TIKTOK_RESOLVE_BASE_DELAY_MS * 2 ** (attempt - 1);
  console.log(
    `[METRICS_SYNC] tiktok-resolve retry draftId=${draftId} status=${result.status} nextAttempt=${attempt + 1} delayMs=${nextDelay}`
  );
  enqueueTiktokVideoIdResolution(draftId, { delayMs: nextDelay, attempt: attempt + 1 });
}

// ── Worker Entry Point ──────────────────────────────────────────────

export function startMetricsSyncWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[METRICS_SYNC] No Redis — worker disabled");
    return { close: async () => {} };
  }

  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));

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
      } else if (job.name === "resolve-tiktok-video-id") {
        await processTiktokResolve({
          draftId: job.data.draftId,
          attempt: job.data.attempt ?? 1,
        });
      }
    },
    { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS }
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
