import crypto from "node:crypto";

export const AI_RELIABILITY_SLOS = Object.freeze({
  pythonApiAvailability: { target: 0.995, window: "30d" },
  workerSuccessRate: { target: 0.99, window: "7d" },
  retrievalLatencyP95Ms: { target: 250, window: "1h" },
  agentPlanLatencyP95Ms: { target: 2000, window: "1h" },
  contentScoringLatencyP95Ms: { target: 500, window: "1h" },
  evalJobCompletionRate: { target: 0.98, window: "24h" },
  queueDelayP95Ms: { target: 30000, window: "1h" },
  traceCompletenessRate: { target: 0.995, window: "24h" },
  costBudgetComplianceRate: { target: 0.99, window: "30d" },
});

export const RETRYABLE_AI_ERROR_CODES = new Set([
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "AI_PLATFORM_DISABLED",
]);

export function backoffDelayMs({
  attempt,
  baseDelayMs = 100,
  maxDelayMs = 5000,
  jitterSeed = "",
}) {
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const digest = crypto
    .createHash("sha256")
    .update(`${jitterSeed}:${attempt}`)
    .digest("hex");
  const jitter = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  return Math.round(exponential * (0.5 + jitter));
}

export function shouldRetryAiOperation({
  attempt,
  maxAttempts = 2,
  errorCode,
  operationSafe = true,
}) {
  return (
    operationSafe &&
    attempt < maxAttempts &&
    RETRYABLE_AI_ERROR_CODES.has(errorCode)
  );
}

export class CircuitBreaker {
  constructor({ failureThreshold = 3, recoveryMs = 30000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.recoveryMs = recoveryMs;
    this.failureCount = 0;
    this.openedAt = null;
  }

  allow(now = Date.now()) {
    return this.openedAt == null || now - this.openedAt >= this.recoveryMs;
  }

  recordSuccess() {
    this.failureCount = 0;
    this.openedAt = null;
  }

  recordFailure(now = Date.now()) {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) this.openedAt = now;
  }
}

export class Bulkhead {
  constructor({ maxInFlight }) {
    this.maxInFlight = maxInFlight;
    this.inFlight = 0;
  }

  acquire() {
    if (this.inFlight >= this.maxInFlight) return false;
    this.inFlight += 1;
    return true;
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

export class WorkspaceQuota {
  constructor({ maxOperations, windowMs }) {
    this.maxOperations = maxOperations;
    this.windowMs = windowMs;
    this.events = new Map();
  }

  allow(workspaceId, now = Date.now()) {
    const retained = (this.events.get(workspaceId) || []).filter(
      (timestamp) => now - timestamp <= this.windowMs,
    );
    if (retained.length >= this.maxOperations) {
      this.events.set(workspaceId, retained);
      return false;
    }
    retained.push(now);
    this.events.set(workspaceId, retained);
    return true;
  }
}

export function costPreflight({ estimatedCostCents, remainingBudgetCents }) {
  if (remainingBudgetCents == null) return { allowed: true, reason: null };
  if (estimatedCostCents > remainingBudgetCents) {
    return { allowed: false, reason: "COST_BUDGET_EXCEEDED" };
  }
  return { allowed: true, reason: null };
}

export function loadSheddingDecision({
  queueDepth = 0,
  activeRequests = 0,
  maxQueueDepth = 1000,
  maxActiveRequests = 100,
}) {
  if (queueDepth >= maxQueueDepth)
    return { shed: true, reason: "QUEUE_BACKPRESSURE" };
  if (activeRequests >= maxActiveRequests)
    return { shed: true, reason: "BULKHEAD_SATURATED" };
  return { shed: false, reason: null };
}

export function classifyFailureDrill(scenario) {
  const drills = {
    python_unavailable: {
      expectedBehavior: "Fallback or typed provider unavailable error.",
      retryable: true,
      rollback: "Disable Python-backed feature flags.",
    },
    redis_unavailable: {
      expectedBehavior: "Pause enqueueing and alert on queue backlog.",
      retryable: true,
      rollback: "Disable queued AI ingestion and workers.",
    },
    postgres_unavailable: {
      expectedBehavior: "Readiness fails closed before AI writes.",
      retryable: true,
      rollback: "Keep feature flags disabled until DB recovers.",
    },
    provider_timeout: {
      expectedBehavior: "Retry safe read-only operations then degrade.",
      retryable: true,
      rollback: "Route to deterministic fallback or Node baseline.",
    },
    invalid_model_artifact: {
      expectedBehavior: "Checksum verification blocks model use.",
      retryable: false,
      rollback: "Pin rollback model version.",
    },
    schema_mismatch: {
      expectedBehavior: "Reject before product action.",
      retryable: false,
      rollback: "Restore previous contract version.",
    },
    clock_skew: {
      expectedBehavior: "Signed request rejected as expired or future dated.",
      retryable: false,
      rollback: "Fix NTP before re-enabling calls.",
    },
    replay_attack: {
      expectedBehavior: "Nonce replay is rejected.",
      retryable: false,
      rollback: "Rotate service auth secret if source is unknown.",
    },
    duplicate_job: {
      expectedBehavior: "Idempotency suppresses duplicate side effects.",
      retryable: false,
      rollback: "Disable enqueueing and inspect dedupe key.",
    },
    trace_backend_unavailable: {
      expectedBehavior:
        "Work may complete but trace completeness SLO breaches.",
      retryable: true,
      rollback: "Do not promote release gates until traces recover.",
    },
  };
  return (
    drills[scenario] ?? {
      expectedBehavior: "Classify before retrying.",
      retryable: false,
      rollback: "Disable affected feature flag.",
    }
  );
}

function percentile(values, pct) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(
    ordered.length - 1,
    Math.ceil((pct / 100) * ordered.length) - 1,
  );
  return ordered[index];
}

export function summarizeLoadSamples(samples) {
  const latencies = samples
    .map((sample) => sample.latencyMs)
    .filter(Number.isFinite);
  const maxElapsed = Math.max(
    1,
    ...samples.map((sample) => sample.elapsedMs || 0),
  );
  return {
    sampleCount: samples.length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    throughputPerSecond: Number(
      (samples.length / (maxElapsed / 1000)).toFixed(6),
    ),
    errorRate:
      samples.length === 0
        ? 0
        : samples.filter((sample) => sample.status === "error").length /
          samples.length,
    queueDepthMax: Math.max(
      0,
      ...samples.map((sample) => sample.queueDepth || 0),
    ),
    redisPressureMax: Math.max(
      0,
      ...samples.map((sample) => sample.redisPressure || 0),
    ),
    dbConnectionsMax: Math.max(
      0,
      ...samples.map((sample) => sample.dbConnections || 0),
    ),
  };
}

export function rollbackPlanForCapability(capability) {
  const plans = {
    retrieval: {
      flag: "ai_retrieval_enabled",
      previousVersion: "clientOrchestrator Node-only context",
      owner: "AI platform on-call",
      dataCompatibility:
        "Derived retrieval rows may be left stale or rebuilt; product records are Node-owned.",
    },
    campaignOpsAgent: {
      flag: "ai_campaign_ops_agent_enabled",
      previousVersion: "No Python campaign ops preview",
      owner: "AI platform on-call",
      dataCompatibility: "No product writes; discard cached previews.",
    },
    brandQualityModel: {
      flag: "ai_brand_quality_model_enabled",
      previousVersion: "deterministic validators only",
      owner: "AI platform on-call",
      dataCompatibility: "Scores are advisory; no product cleanup.",
    },
    experimentation: {
      flag: "ai_experimentation_enabled",
      previousVersion: "observational analytics only",
      owner: "AI platform on-call",
      dataCompatibility:
        "Exposure/outcome records remain Node-owned; reports can be regenerated.",
    },
  };
  return (
    plans[capability] ?? {
      flag: "feature flag for capability",
      previousVersion: "last known good Node baseline",
      owner: "AI platform on-call",
      dataCompatibility: "Do not delete product records during rollback.",
    }
  );
}
