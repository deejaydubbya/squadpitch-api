#!/usr/bin/env node
import { getNotificationQueue } from "../lib/queues.js";
import { SMS_AVAILABILITY } from "../domains/sms/smsAvailability.js";

const queue = getNotificationQueue();
if (!queue) {
  console.error("FAIL code=REDIS_UNAVAILABLE");
  process.exit(1);
}

const states = ["waiting", "delayed", "active", "failed"];
const counts = {};
for (const state of states) {
  const jobs = await queue.getJobs([state], 0, 999, true);
  counts[state] = jobs.filter(
    (job) => job.name === "send-notification-sms",
  ).length;
}
const failedJobs = await queue.getJobs(["failed"], 0, 999, true);
counts.retrying = failedJobs.filter(
  (job) =>
    job.name === "send-notification-sms" &&
    job.attemptsMade < (job.opts?.attempts ?? 1),
).length;
const repeatable = await queue.getRepeatableJobs();
counts.repeatable = repeatable.filter(
  (job) => job.name === "send-notification-sms",
).length;

console.log(
  JSON.stringify({
    status: SMS_AVAILABILITY.status,
    availability: SMS_AVAILABILITY.availability,
    reason: SMS_AVAILABILITY.reason,
    queue: "sp-notification",
    smsJobs: counts,
  }),
);
await queue.close();
