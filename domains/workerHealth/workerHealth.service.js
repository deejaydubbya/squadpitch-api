import os from "node:os";
import { Queue, QueueEvents, Worker } from "bullmq";
import { env } from "../../config/env.js";
import { getAllQueues } from "../../lib/queues.js";
import { captureWorkerHealthIncident } from "../../lib/sentry.js";
import { boundedQueueOptions, CONSERVATIVE_WORKER_OPTIONS } from "../../lib/bullmqOptions.js";
import { getRedis, getRedisConnection, redisSetNX } from "../../redis.js";

export const WORKER_HEALTH_QUEUE = "sp-worker-health";
export const WORKER_HEALTH_JOB = "[SYNTHETIC CANARY] worker-health";
export const WORKER_HEALTH_THRESHOLDS = Object.freeze({
  heartbeatStaleMs: 5 * 60_000,
  heartbeatTtlSeconds: 600,
  waitingWarn: 25,
  waitingCritical: 100,
  oldestWaitingWarnMs: 5 * 60_000,
  oldestWaitingCriticalMs: 15 * 60_000,
  failureWindowMs: 15 * 60_000,
  failedWarn: 3,
  failedCritical: 10,
  syntheticTimeoutMs: 15_000,
  alertCooldownSeconds: 15 * 60,
});

const PREFIX = "sp:worker-health";

export function startWorkerHealthWorker({
  connection = getRedisConnection(),
  redis = getRedis(),
  now = () => Date.now(),
} = {}) {
  if (!connection || !redis) return null;
  const instance = process.env.FLY_MACHINE_ID ?? os.hostname();
  const release = env.APP_BUILD_SHA ?? process.env.FLY_IMAGE_REF ?? null;
  const worker = new Worker(
    WORKER_HEALTH_QUEUE,
    (job) => processWorkerHealthJob(job, { redis, now }),
    { connection, concurrency: 1, ...CONSERVATIVE_WORKER_OPTIONS },
  );

  const writeHeartbeat = async () => {
    const timestamp = now();
    const payload = JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      service: "api-worker",
      instance,
      release,
      status: worker.isRunning() ? "running" : "starting",
    });
    await redis.set(
      `${PREFIX}:heartbeat:api-worker:${instance}`,
      payload,
      "EX",
      WORKER_HEALTH_THRESHOLDS.heartbeatTtlSeconds,
    );
    await redis.zadd(`${PREFIX}:instances:api-worker`, timestamp, instance);
    await redis.zremrangebyscore(
      `${PREFIX}:instances:api-worker`,
      0,
      timestamp - WORKER_HEALTH_THRESHOLDS.heartbeatTtlSeconds * 2_000,
    );
  };
  void writeHeartbeat();
  const heartbeatTimer = setInterval(
    () => void writeHeartbeat().catch(() => {}),
    120_000,
  );
  heartbeatTimer.unref?.();

  worker.on("failed", (job, error) => {
    void recordWorkerIncident({
      redis,
      type: "job-failed",
      severity:
        job && job.attemptsMade >= (job.opts.attempts ?? 1)
          ? "critical"
          : "warning",
      queue: WORKER_HEALTH_QUEUE,
      jobType: job?.name,
      error,
      synthetic: job?.data?.synthetic === true,
    });
  });
  worker.on("stalled", (jobId) => {
    void recordWorkerIncident({
      redis,
      type: "job-stalled",
      severity: "warning",
      queue: WORKER_HEALTH_QUEUE,
      jobType: "unknown",
      error: Object.assign(new Error("Worker-health job stalled"), {
        code: "WORKER_JOB_STALLED",
        jobId,
      }),
      synthetic: true,
    });
  });

  const close = worker.close.bind(worker);
  worker.close = async (...args) => {
    clearInterval(heartbeatTimer);
    return close(...args);
  };
  return worker;
}

export async function processWorkerHealthJob(
  job,
  { redis, now = () => Date.now() },
) {
  if (job.name !== WORKER_HEALTH_JOB || job.data?.synthetic !== true) {
    throw Object.assign(new Error("Unsupported worker-health job"), {
      code: "WORKER_HEALTH_JOB_REJECTED",
    });
  }
  const completedAt = now();
  await redis.hset(`${PREFIX}:metrics:${WORKER_HEALTH_QUEUE}`, {
    lastSuccessAt: String(completedAt),
    lastCorrelationId: String(job.data.correlationId ?? "unknown"),
    lastLatencyMs: String(Math.max(0, completedAt - job.timestamp)),
  });
  return { correlationId: job.data.correlationId, completedAt };
}

export async function runWorkerHealthRoundTrip({
  correlationId,
  queueConnection = getRedisConnection(),
  eventsConnection = getRedisConnection(),
  timeoutMs = WORKER_HEALTH_THRESHOLDS.syntheticTimeoutMs,
} = {}) {
  if (!queueConnection || !eventsConnection) {
    await closeRedis(queueConnection);
    await closeRedis(eventsConnection);
    throw new Error("Redis connection unavailable");
  }
  const queue = new Queue(WORKER_HEALTH_QUEUE, boundedQueueOptions(queueConnection));
  const events = new QueueEvents(WORKER_HEALTH_QUEUE, {
    connection: eventsConnection,
  });
  const startedAt = Date.now();
  // Subscribe before enqueueing. The standing worker can finish this tiny job
  // before QueueEvents is ready, which otherwise makes a successful job look
  // like a timeout under production latency.
  await events.waitUntilReady();
  const job = await queue.add(
    WORKER_HEALTH_JOB,
    { synthetic: true, correlationId },
    {
      jobId: `worker-health-${correlationId}`,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 500 },
    },
  );
  try {
    const value = await job.waitUntilFinished(events, timeoutMs);
    if (value?.correlationId !== correlationId) {
      throw new Error("Worker-health correlation mismatch");
    }
    await job.remove();
    return {
      consumed: true,
      removed: (await queue.getJob(job.id)) == null,
      correlationId,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    await events.close().catch(() => {});
    await queue.close().catch(() => {});
    await closeRedis(queueConnection);
    await closeRedis(eventsConnection);
  }
}

export async function inspectWorkerHealth({
  redis = getRedis(),
  queues = null,
  now = Date.now(),
} = {}) {
  if (!redis) return blockedReport(now, "Redis is unavailable");
  try {
    if ((await redis.ping()) !== "PONG") {
      return blockedReport(now, "Redis PING failed");
    }
    const heartbeats = await readHeartbeats(redis, now);
    const healthConnection = queues ? null : getRedisConnection();
    if (!queues && !healthConnection)
      return blockedReport(now, "Redis is unavailable");
    const healthQueue = healthConnection
      ? new Queue(WORKER_HEALTH_QUEUE, boundedQueueOptions(healthConnection))
      : null;
    const queueEntries = queues ?? [
      ...getAllQueues(),
      { name: WORKER_HEALTH_QUEUE, queue: healthQueue },
    ];
    const aggregate = await aggregateQueues(queueEntries, now);
    if (healthQueue) await healthQueue.close().catch(() => {});
    const report = classifyWorkerHealth({ now, heartbeats, aggregate });
    await emitAggregateAlerts(report, redis);
    return report;
  } catch {
    return blockedReport(now, "Worker health inspection failed");
  }
}

// Readiness deliberately avoids queue enumeration and job-history scans. The
// detailed inspector above is reserved for explicit operator diagnostics.
export async function inspectWorkerReadiness({
  redis = getRedis(),
  now = Date.now(),
} = {}) {
  if (!redis) return { status: "blocked" };
  try {
    const heartbeats = await readHeartbeats(redis, now);
    const apiFresh = heartbeats.some(
      (item) =>
        item.service === "api-worker" &&
        item.ageMs <= WORKER_HEALTH_THRESHOLDS.heartbeatStaleMs,
    );
    const aiFresh = heartbeats.some(
      (item) =>
        item.service === "squadpitch-ai-worker" &&
        item.ageMs <= WORKER_HEALTH_THRESHOLDS.heartbeatStaleMs,
    );
    return {
      status: apiFresh && aiFresh ? "healthy" : "blocked",
      services: { apiWorkerFresh: apiFresh, aiWorkerFresh: aiFresh },
    };
  } catch {
    return { status: "blocked" };
  }
}

export function classifyWorkerHealth({ now, heartbeats, aggregate }) {
  const apiFresh = heartbeats.some(
    (item) =>
      item.service === "api-worker" &&
      item.ageMs <= WORKER_HEALTH_THRESHOLDS.heartbeatStaleMs,
  );
  const aiFresh = heartbeats.some(
    (item) =>
      item.service === "squadpitch-ai-worker" &&
      item.ageMs <= WORKER_HEALTH_THRESHOLDS.heartbeatStaleMs,
  );
  const status =
    !apiFresh || !aiFresh || aggregate.critical.length
      ? "blocked"
      : aggregate.warnings.length
        ? "degraded"
        : "healthy";
  return {
    schemaVersion: "worker-health.v1",
    observedAt: new Date(now).toISOString(),
    status,
    redisReachable: true,
    processRunning: heartbeats.length > 0,
    heartbeatFresh: apiFresh && aiFresh,
    services: {
      apiWorkerFresh: apiFresh,
      aiWorkerFresh: aiFresh,
      instances: heartbeats.length,
    },
    queues: aggregate,
    thresholds: WORKER_HEALTH_THRESHOLDS,
  };
}

async function readHeartbeats(redis, now) {
  const cutoff = now - WORKER_HEALTH_THRESHOLDS.heartbeatTtlSeconds * 2_000;
  const items = [];
  for (const service of ["api-worker", "squadpitch-ai-worker"]) {
    const instances = await redis.zrangebyscore(
      `${PREFIX}:instances:${service}`,
      cutoff,
      "+inf",
    );
    for (const instance of instances) {
      const raw = await redis.get(`${PREFIX}:heartbeat:${service}:${instance}`);
      if (!raw) continue;
      try {
        const value = JSON.parse(raw);
        const timestamp = Date.parse(value.timestamp);
        if (Number.isFinite(timestamp)) {
          items.push({ service, ageMs: Math.max(0, now - timestamp) });
        }
      } catch {}
    }
  }
  return items;
}

async function aggregateQueues(entries, now) {
  const totals = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failedRecent: 0,
    stalledRecent: 0,
    retryExhaustedRecent: 0,
  };
  let oldestWaitingAgeMs = 0;
  let oldestDelayedAgeMs = 0;
  const perQueue = [];
  for (const { name, queue } of entries) {
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    const waitingJob = (await queue.getJobs(["waiting"], 0, 0, true))[0];
    const delayedJob = (await queue.getJobs(["delayed"], 0, 0, true))[0];
    const failedJobs = await queue.getJobs(["failed"], 0, 99, true);
    const recent = failedJobs.filter(
      (job) =>
        (job.finishedOn ?? 0) >= now - WORKER_HEALTH_THRESHOLDS.failureWindowMs,
    );
    const stalled = recent.filter((job) =>
      /stalled/i.test(job.failedReason ?? ""),
    );
    const exhausted = recent.filter(
      (job) => job.attemptsMade >= (job.opts.attempts ?? 1),
    );
    const waitingAge = waitingJob ? Math.max(0, now - waitingJob.timestamp) : 0;
    const delayedAge = delayedJob ? Math.max(0, now - delayedJob.timestamp) : 0;
    totals.waiting += counts.waiting;
    totals.active += counts.active;
    totals.delayed += counts.delayed;
    totals.failedRecent += recent.length;
    totals.stalledRecent += stalled.length;
    totals.retryExhaustedRecent += exhausted.length;
    oldestWaitingAgeMs = Math.max(oldestWaitingAgeMs, waitingAge);
    oldestDelayedAgeMs = Math.max(oldestDelayedAgeMs, delayedAge);
    perQueue.push({
      queue: name,
      waiting: counts.waiting,
      active: counts.active,
      delayed: counts.delayed,
      failedRecent: recent.length,
      stalledRecent: stalled.length,
      retryExhaustedRecent: exhausted.length,
      oldestWaitingAgeMs: waitingAge,
      oldestDelayedAgeMs: delayedAge,
    });
  }
  const warnings = [];
  const critical = [];
  if (totals.waiting >= WORKER_HEALTH_THRESHOLDS.waitingCritical)
    critical.push("queue_backlog");
  else if (totals.waiting >= WORKER_HEALTH_THRESHOLDS.waitingWarn)
    warnings.push("queue_backlog");
  if (oldestWaitingAgeMs > WORKER_HEALTH_THRESHOLDS.oldestWaitingCriticalMs)
    critical.push("oldest_waiting");
  else if (oldestWaitingAgeMs > WORKER_HEALTH_THRESHOLDS.oldestWaitingWarnMs)
    warnings.push("oldest_waiting");
  if (totals.failedRecent >= WORKER_HEALTH_THRESHOLDS.failedCritical)
    critical.push("failed_rate");
  else if (totals.failedRecent >= WORKER_HEALTH_THRESHOLDS.failedWarn)
    warnings.push("failed_rate");
  if (totals.stalledRecent > 0) warnings.push("stalled");
  if (totals.retryExhaustedRecent > 0) warnings.push("retry_exhaustion");
  return {
    totals,
    oldestWaitingAgeMs,
    oldestDelayedAgeMs,
    perQueue,
    warnings,
    critical,
  };
}

async function recordWorkerIncident({
  redis,
  type,
  severity,
  queue,
  jobType,
  error,
  synthetic,
}) {
  const cooldown = await redisSetNX(
    `${PREFIX}:alert-cooldown:${type}:${queue}`,
    String(Date.now()),
    WORKER_HEALTH_THRESHOLDS.alertCooldownSeconds,
  );
  if (!cooldown) return;
  captureWorkerHealthIncident(error, {
    source: "worker-health",
    service: "api-worker",
    environment: env.NODE_ENV,
    queue,
    job_type: jobType,
    synthetic: String(synthetic === true),
    severity,
    release: env.APP_BUILD_SHA,
    error_class: error?.code ?? error?.name ?? "Error",
    incident_type: type,
  });
}

async function emitAggregateAlerts(report, redis) {
  const incidents = [];
  if (!report.heartbeatFresh)
    incidents.push(["heartbeat-stale", "critical", "worker-heartbeat"]);
  for (const type of report.queues?.critical ?? [])
    incidents.push([type, "critical", "aggregate"]);
  for (const type of report.queues?.warnings ?? [])
    incidents.push([type, "warning", "aggregate"]);
  for (const [type, severity, queue] of incidents) {
    await recordWorkerIncident({
      redis,
      type,
      severity,
      queue,
      jobType: "aggregate",
      error: Object.assign(new Error(`Worker health incident: ${type}`), {
        code: `WORKER_HEALTH_${type.toUpperCase().replaceAll("-", "_")}`,
      }),
      synthetic: false,
    });
  }
}

function blockedReport(now, reason) {
  return {
    schemaVersion: "worker-health.v1",
    observedAt: new Date(now).toISOString(),
    status: "blocked",
    redisReachable: false,
    processRunning: false,
    heartbeatFresh: false,
    reason,
  };
}

async function closeRedis(connection) {
  if (connection) await connection.quit().catch(() => {});
}
