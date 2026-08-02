import { Queue, Worker } from "bullmq";
import { getRedisConnection, redisDel, redisSetNX } from "../redis.js";
import { runContactRetention } from "../domains/inbox/contactRetention.service.js";

const QUEUE_NAME = "sp-contact-retention";
const LOCK_KEY = "sp:lock:contact-retention";

export function startContactRetentionWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[CONTACT_RETENTION] No Redis — worker disabled");
    return null;
  }
  const queue = new Queue(QUEUE_NAME, { connection });
  queue.add("daily-contact-retention", {}, {
    repeat: { pattern: "17 3 * * *" },
    jobId: "daily-contact-retention-repeat",
  }).catch((error) => console.error("[CONTACT_RETENTION] schedule failed:", error.message));
  const worker = new Worker(QUEUE_NAME, async () => {
    const acquired = await redisSetNX(LOCK_KEY, "1", 60 * 60);
    if (!acquired) return { skipped: "overlap" };
    try {
      const result = await runContactRetention();
      console.info("[CONTACT_RETENTION] completed", {
        workspaces: result.workspaces,
        contactsDeleted: result.contactsDeleted,
        batches: result.batches,
      });
      return result;
    } finally {
      await redisDel(LOCK_KEY);
    }
  }, { connection, concurrency: 1 });
  worker.on("failed", (job, error) => {
    console.error("[CONTACT_RETENTION] job failed", { jobId: job?.id, error: error?.message });
  });
  return { close: async () => { await worker.close(); await queue.close(); } };
}
