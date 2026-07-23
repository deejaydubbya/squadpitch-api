import { describe, expect, it } from "vitest";

import {
  AI_RELIABILITY_SLOS,
  Bulkhead,
  CircuitBreaker,
  WorkspaceQuota,
  backoffDelayMs,
  classifyFailureDrill,
  costPreflight,
  loadSheddingDecision,
  rollbackPlanForCapability,
  shouldRetryAiOperation,
  summarizeLoadSamples,
} from "../domains/aiPlatform/reliability.service.js";

describe("AI platform reliability policies", () => {
  it("defines required SLO targets", () => {
    expect(
      AI_RELIABILITY_SLOS.pythonApiAvailability.target,
    ).toBeGreaterThanOrEqual(0.995);
    expect(AI_RELIABILITY_SLOS.workerSuccessRate.target).toBeGreaterThanOrEqual(
      0.99,
    );
    expect(
      AI_RELIABILITY_SLOS.retrievalLatencyP95Ms.target,
    ).toBeLessThanOrEqual(250);
    expect(
      AI_RELIABILITY_SLOS.contentScoringLatencyP95Ms.target,
    ).toBeLessThanOrEqual(500);
    expect(
      AI_RELIABILITY_SLOS.traceCompletenessRate.target,
    ).toBeGreaterThanOrEqual(0.995);
  });

  it("applies safe retry policy with deterministic jitter", () => {
    expect(
      shouldRetryAiOperation({
        attempt: 1,
        maxAttempts: 2,
        errorCode: "PROVIDER_TIMEOUT",
        operationSafe: true,
      }),
    ).toBe(true);
    expect(
      shouldRetryAiOperation({
        attempt: 1,
        maxAttempts: 2,
        errorCode: "PROVIDER_TIMEOUT",
        operationSafe: false,
      }),
    ).toBe(false);
    expect(backoffDelayMs({ attempt: 2, jitterSeed: "workspace-a" })).toBe(
      backoffDelayMs({ attempt: 2, jitterSeed: "workspace-a" }),
    );
  });

  it("opens circuit breakers, enforces bulkheads, and applies workspace quotas", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      recoveryMs: 1000,
    });
    breaker.recordFailure(100);
    expect(breaker.allow(200)).toBe(true);
    breaker.recordFailure(300);
    expect(breaker.allow(400)).toBe(false);
    expect(breaker.allow(1400)).toBe(true);

    const bulkhead = new Bulkhead({ maxInFlight: 1 });
    expect(bulkhead.acquire()).toBe(true);
    expect(bulkhead.acquire()).toBe(false);
    bulkhead.release();
    expect(bulkhead.acquire()).toBe(true);

    const quota = new WorkspaceQuota({ maxOperations: 2, windowMs: 1000 });
    expect(quota.allow("workspace-a", 1)).toBe(true);
    expect(quota.allow("workspace-a", 2)).toBe(true);
    expect(quota.allow("workspace-a", 3)).toBe(false);
    expect(quota.allow("workspace-a", 2000)).toBe(true);
  });

  it("handles load shedding, cost preflight, drills, rollback, and load metrics", () => {
    expect(loadSheddingDecision({ queueDepth: 1000 }).reason).toBe(
      "QUEUE_BACKPRESSURE",
    );
    expect(loadSheddingDecision({ activeRequests: 100 }).reason).toBe(
      "BULKHEAD_SATURATED",
    );
    expect(
      costPreflight({ estimatedCostCents: 20, remainingBudgetCents: 10 }),
    ).toEqual({
      allowed: false,
      reason: "COST_BUDGET_EXCEEDED",
    });
    expect(classifyFailureDrill("replay_attack")).toMatchObject({
      retryable: false,
    });
    expect(rollbackPlanForCapability("brandQualityModel")).toMatchObject({
      flag: "ai_brand_quality_model_enabled",
      previousVersion: "deterministic validators only",
    });

    const summary = summarizeLoadSamples([
      {
        latencyMs: 10,
        elapsedMs: 100,
        status: "ok",
        queueDepth: 1,
        redisPressure: 2,
        dbConnections: 3,
      },
      {
        latencyMs: 30,
        elapsedMs: 200,
        status: "error",
        queueDepth: 4,
        redisPressure: 5,
        dbConnections: 6,
      },
      {
        latencyMs: 20,
        elapsedMs: 300,
        status: "ok",
        queueDepth: 2,
        redisPressure: 1,
        dbConnections: 1,
      },
    ]);
    expect(summary.p50LatencyMs).toBe(20);
    expect(summary.p95LatencyMs).toBe(30);
    expect(summary.errorRate).toBeCloseTo(1 / 3);
    expect(summary.queueDepthMax).toBe(4);
  });
});
