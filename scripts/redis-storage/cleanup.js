import { Queue } from "bullmq";
import { env } from "../../config/env.js";
import { boundedQueueOptions } from "../../lib/bullmqOptions.js";
import { getRedisConnection } from "../../redis.js";
import { QUEUE_ALLOWLIST } from "./common.js";

const execute = process.argv.includes("--execute");
const confirmed = process.argv.includes("--confirm=DELETE_EXPIRED_HISTORY");
if (!env.REDIS_URL) throw new Error("REDIS_URL is required");
if (execute && !confirmed) {
  throw new Error("Execution requires --confirm=DELETE_EXPIRED_HISTORY");
}

const policies = [
  { status: "completed", graceMs: 24 * 60 * 60 * 1000 },
  { status: "failed", graceMs: 14 * 24 * 60 * 60 * 1000 },
];
const results = [];

for (const queueName of QUEUE_ALLOWLIST) {
  const connection = getRedisConnection();
  if (!connection) throw new Error("Redis connection unavailable");
  const queue = new Queue(queueName, boundedQueueOptions(connection));
  try {
    const counts = await queue.getJobCounts(
      "completed",
      "failed",
      "active",
      "waiting",
      "delayed",
      "paused",
    );
    const removed = {};
    if (execute) {
      for (const policy of policies) {
        removed[policy.status] = (
          await queue.clean(policy.graceMs, 1000, policy.status)
        ).length;
      }
    }
    results.push({ queueName, counts, removed });
  } finally {
    await queue.close();
    if (connection.status !== "end") {
      await connection.quit().catch(() => connection.disconnect());
    }
  }
}

console.log(
  JSON.stringify(
    {
      event: "redis.queue_history.cleanup",
      mode: execute ? "executed" : "dry-run",
      eligibleStatuses: policies.map((item) => item.status),
      protectedStatuses: ["active", "waiting", "delayed", "paused", "repeatable"],
      results,
    },
    null,
    2,
  ),
);
