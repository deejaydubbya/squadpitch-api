import { getAllQueues } from "../../lib/queues.js";

// ── Queue Metadata ──────────────────────────────────────────────────────

const QUEUE_META = {
  "sp-media-gen": { label: "Media Generation", category: "content", icon: "image" },
  "sp-video-gen": { label: "Video Generation", category: "content", icon: "video" },
  "sp-notification": { label: "Notifications", category: "delivery", icon: "bell" },
  "sp-metrics-sync": { label: "Metrics Sync", category: "analytics", icon: "bar-chart" },
  "sp-analytics-recalc": { label: "Analytics Recalc", category: "analytics", icon: "calculator" },
  "sp-insights-refresh": { label: "Insights Refresh", category: "analytics", icon: "lightbulb" },
  "sp-scheduled-publish": { label: "Scheduled Publishing", category: "delivery", icon: "clock" },
  "sp-weekly-digest": { label: "Weekly Digest", category: "delivery", icon: "mail" },
};

// ── Payload Sanitization ────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "accessToken", "refreshToken", "token", "secret", "auth",
  "p256dh", "webhookUrl", "targetUrl", "endpoint", "password",
  "apiKey", "apiSecret", "clientSecret",
]);

function sanitizePayload(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizePayload);

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizePayload(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Context Derivation ──────────────────────────────────────────────────

function deriveContext(queueName, data) {
  if (!data) return { context: null, workspaceId: null };

  switch (queueName) {
    case "sp-media-gen":
      return {
        context: data.assetId ? `Image generation for asset ${data.assetId}` : "Media generation",
        workspaceId: data.clientId || null,
      };
    case "sp-video-gen":
      return {
        context: data.assetId ? `Video generation for asset ${data.assetId}` : "Video generation",
        workspaceId: data.clientId || null,
      };
    case "sp-notification": {
      const target = data.userId || data.logId || null;
      return {
        context: target ? `Notification for ${target}` : "Notification delivery",
        workspaceId: data.clientId || null,
      };
    }
    case "sp-metrics-sync":
      return {
        context: data.draftId ? `Metrics sync for draft ${data.draftId}` : "Metrics polling",
        workspaceId: data.clientId || null,
      };
    case "sp-analytics-recalc":
      return {
        context: data.clientId ? `Analytics recalc for ${data.clientId}` : "Analytics recalculation",
        workspaceId: data.clientId || null,
      };
    case "sp-insights-refresh":
      return {
        context: data.clientId ? `Insights refresh for ${data.clientId}` : "Insights refresh",
        workspaceId: data.clientId || null,
      };
    case "sp-scheduled-publish":
      return { context: "Scheduled publish polling", workspaceId: null };
    case "sp-weekly-digest":
      return { context: "Weekly digest run", workspaceId: null };
    default:
      return { context: null, workspaceId: null };
  }
}

// ── Job Status Detection ────────────────────────────────────────────────

function getJobStatus(job) {
  // BullMQ doesn't store status directly — derive from state fields
  if (job.failedReason || job.stacktrace?.length) return "failed";
  if (job.finishedOn) return "completed";
  if (job.processedOn && !job.finishedOn) return "active";
  if (job.delay && job.delay > 0 && !job.processedOn) return "delayed";
  return "waiting";
}

// ── Service Functions ───────────────────────────────────────────────────

/**
 * Returns summary counts for all queues.
 */
export async function getQueueSummary() {
  const queues = getAllQueues();
  const results = await Promise.all(
    queues.map(async ({ name, queue }) => {
      try {
        const counts = await queue.getJobCounts(
          "active", "waiting", "delayed", "failed", "completed", "paused"
        );
        const meta = QUEUE_META[name] || { label: name, category: "other", icon: "box" };
        return {
          queue: name,
          label: meta.label,
          category: meta.category,
          icon: meta.icon,
          counts,
        };
      } catch (err) {
        console.error(`[JOBS] Failed to get counts for ${name}:`, err.message);
        return {
          queue: name,
          label: (QUEUE_META[name] || {}).label || name,
          category: (QUEUE_META[name] || {}).category || "other",
          icon: (QUEUE_META[name] || {}).icon || "box",
          counts: { active: 0, waiting: 0, delayed: 0, failed: 0, completed: 0, paused: 0 },
          error: err.message,
        };
      }
    })
  );
  return results;
}

/**
 * Lists jobs with optional filters.
 */
export async function listJobs({ queue: queueFilter, status = "failed", type, limit = 25, offset = 0 }) {
  const allQueues = getAllQueues();
  const targetQueues = queueFilter
    ? allQueues.filter(({ name }) => name === queueFilter)
    : allQueues;

  if (targetQueues.length === 0) {
    return { items: [], total: 0 };
  }

  const statuses = status === "all"
    ? ["active", "waiting", "delayed", "failed", "completed"]
    : [status];

  // Fetch from each target queue
  const jobsByQueue = await Promise.all(
    targetQueues.map(async ({ name, queue }) => {
      try {
        const jobs = await queue.getJobs(statuses, 0, limit + offset + 50);
        return jobs.map((job) => ({ job, queueName: name }));
      } catch (err) {
        console.error(`[JOBS] Failed to list jobs for ${name}:`, err.message);
        return [];
      }
    })
  );

  let allJobs = jobsByQueue.flat();

  // Filter by job type/name if specified
  if (type) {
    allJobs = allJobs.filter(({ job }) => job.name === type);
  }

  // Sort by timestamp descending (newest first)
  allJobs.sort((a, b) => (b.job.timestamp || 0) - (a.job.timestamp || 0));

  const total = allJobs.length;
  const paged = allJobs.slice(offset, offset + limit);

  const items = paged.map(({ job, queueName }) => {
    const { context, workspaceId } = deriveContext(queueName, job.data);
    const meta = QUEUE_META[queueName] || { label: queueName };
    return {
      id: job.id,
      queue: queueName,
      queueLabel: meta.label,
      name: job.name,
      status: getJobStatus(job),
      data: sanitizePayload(job.data),
      timestamp: job.timestamp,
      processedOn: job.processedOn || null,
      finishedOn: job.finishedOn || null,
      attemptsMade: job.attemptsMade || 0,
      attemptsMax: job.opts?.attempts || 1,
      failedReason: job.failedReason || null,
      workspaceId,
      context,
    };
  });

  return { items, total };
}

/**
 * Returns full detail for a specific job.
 */
export async function getJobDetail(queueName, jobId) {
  const allQueues = getAllQueues();
  const entry = allQueues.find(({ name }) => name === queueName);
  if (!entry) return null;

  const job = await entry.queue.getJob(jobId);
  if (!job) return null;

  const { context, workspaceId } = deriveContext(queueName, job.data);
  const meta = QUEUE_META[queueName] || { label: queueName };

  return {
    id: job.id,
    queue: queueName,
    queueLabel: meta.label,
    name: job.name,
    status: getJobStatus(job),
    data: sanitizePayload(job.data),
    returnvalue: job.returnvalue || null,
    timestamp: job.timestamp,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
    delay: job.delay || 0,
    attemptsMade: job.attemptsMade || 0,
    attemptsMax: job.opts?.attempts || 1,
    failedReason: job.failedReason || null,
    stacktrace: job.stacktrace || [],
    workspaceId,
    context,
  };
}

/**
 * Retries a failed job.
 */
export async function retryJob(queueName, jobId) {
  const allQueues = getAllQueues();
  const entry = allQueues.find(({ name }) => name === queueName);
  if (!entry) throw new Error(`Queue "${queueName}" not found`);

  const job = await entry.queue.getJob(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found in queue "${queueName}"`);

  const status = getJobStatus(job);
  if (status !== "failed") {
    throw new Error(`Job "${jobId}" is ${status}, only failed jobs can be retried`);
  }

  await job.retry();
  return { ok: true, jobId, queue: queueName };
}

/**
 * Removes a completed or failed job.
 */
export async function removeJob(queueName, jobId) {
  const allQueues = getAllQueues();
  const entry = allQueues.find(({ name }) => name === queueName);
  if (!entry) throw new Error(`Queue "${queueName}" not found`);

  const job = await entry.queue.getJob(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found in queue "${queueName}"`);

  const status = getJobStatus(job);
  if (status !== "completed" && status !== "failed") {
    throw new Error(`Job "${jobId}" is ${status}, only completed or failed jobs can be removed`);
  }

  await job.remove();
  return { ok: true, jobId, queue: queueName };
}
