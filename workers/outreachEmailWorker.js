import { Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";
import { failQueuedOutreachEmail, sendOutreachEmail } from "../domains/prospects/outreach.service.js";

const QUEUE_NAME = "sp-outreach-email";

export function startOutreachEmailWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;
  return new Worker(QUEUE_NAME, async (job) => {
    try {
      return await sendOutreachEmail(job.data.prospectId, job.data.sendingAccountId, { waitForDelay: true });
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) await failQueuedOutreachEmail(job.data.prospectId, error);
      throw error;
    }
  }, { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS, lockDuration: 2 * 60 * 60_000 });
}
