import { Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";
import { executeProspectPreparation, failPreparationRun } from "../domains/prospects/prospect.service.js";

const QUEUE_NAME = "sp-prospect-preparation";

export function startProspectPreparationWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;
  return new Worker(QUEUE_NAME, async (job) => {
    try {
      return await executeProspectPreparation(job.data.runId);
    } catch (error) {
      await failPreparationRun(job.data.runId, error);
      throw error;
    }
  }, { connection, concurrency: 2, ...CONSERVATIVE_WORKER_OPTIONS, lockDuration: 10 * 60_000 });
}
