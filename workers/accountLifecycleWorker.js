import { Queue, Worker } from "bullmq";
import { getRedisConnection, redisDel, redisSetNX } from "../redis.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";
import { runAccountLifecycleMaintenance } from "../domains/account/accountDeletionProviders.service.js";

const QUEUE_NAME = "sp-account-lifecycle";
const LOCK_KEY = "sp:lock:account-lifecycle";

export function startAccountLifecycleWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;
  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));
  queue.add("daily-account-lifecycle", {}, { repeat: { pattern: "41 3 * * *" }, jobId: "daily-account-lifecycle-repeat" }).catch(error => console.error("[ACCOUNT_LIFECYCLE] schedule failed", { code: error.code ?? "SCHEDULE_FAILED" }));
  const worker = new Worker(QUEUE_NAME, async () => {
    if (!await redisSetNX(LOCK_KEY, "1", 60 * 60)) return { skipped: "overlap" };
    try { return await runAccountLifecycleMaintenance(); }
    finally { await redisDel(LOCK_KEY); }
  }, { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS });
  worker.on("failed", (job, error) => console.error("[ACCOUNT_LIFECYCLE] job failed", { jobId: job?.id, code: error.code ?? "JOB_FAILED" }));
  return { close: async () => { await worker.close(); await queue.close(); } };
}
