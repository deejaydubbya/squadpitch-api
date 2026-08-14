import { Queue, Worker } from "bullmq";
import { getRedisConnection, redisDel, redisSetNX } from "../redis.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";
import { processDueReferralRewards } from "../domains/referrals/referral.service.js";

const QUEUE_NAME = "sp-referral-qualification";
const LOCK_KEY = "sp:lock:referral-qualification";

export function startReferralQualificationWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;
  const queue = new Queue(QUEUE_NAME, boundedQueueOptions(connection));
  const worker = new Worker(QUEUE_NAME, async () => {
    if (!await redisSetNX(LOCK_KEY, "1", 60 * 60)) return { skipped: "overlap" };
    try { return await processDueReferralRewards(); }
    finally { await redisDel(LOCK_KEY); }
  }, { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS });
  queue.add("daily-referral-qualification", {}, { repeat: { pattern: "23 4 * * *" }, jobId: "daily-referral-qualification-repeat" }).catch((error) => console.error("[REFERRAL] schedule failed", { code: error.code ?? "SCHEDULE_FAILED" }));
  worker.on("failed", (job, error) => console.error("[REFERRAL] job failed", { jobId: job?.id, code: error.code ?? "JOB_FAILED" }));
  return { close: async () => { await worker.close(); await queue.close(); } };
}
