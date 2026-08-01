import { describe, expect, it, vi } from "vitest";
import {
  classifyWorkerHealth,
  processWorkerHealthJob,
  WORKER_HEALTH_JOB,
  WORKER_HEALTH_THRESHOLDS,
} from "../domains/workerHealth/workerHealth.service.js";

describe("worker health", () => {
  it("accepts only the dedicated synthetic job and records safe aggregates", async () => {
    const redis = { hset: vi.fn(async () => 1) };
    const result = await processWorkerHealthJob(
      {
        name: WORKER_HEALTH_JOB,
        data: { synthetic: true, correlationId: "correlation-1" },
        timestamp: 900,
      },
      { redis, now: () => 1000 },
    );
    expect(result).toEqual({
      correlationId: "correlation-1",
      completedAt: 1000,
    });
    expect(redis.hset).toHaveBeenCalledWith(
      "sp:worker-health:metrics:sp-worker-health",
      {
        lastSuccessAt: "1000",
        lastCorrelationId: "correlation-1",
        lastLatencyMs: "100",
      },
    );
    await expect(
      processWorkerHealthJob(
        { name: "customer-job", data: {}, timestamp: 900 },
        { redis, now: () => 1000 },
      ),
    ).rejects.toMatchObject({ code: "WORKER_HEALTH_JOB_REJECTED" });
  });

  it("requires both fresh worker services and healthy queue aggregates", () => {
    const now = Date.now();
    const report = classifyWorkerHealth({
      now,
      heartbeats: [
        { service: "api-worker", ageMs: 10_000 },
        { service: "squadpitch-ai-worker", ageMs: 20_000 },
      ],
      aggregate: {
        warnings: [],
        critical: [],
        totals: { waiting: 0 },
      },
    });
    expect(report).toMatchObject({
      status: "healthy",
      redisReachable: true,
      heartbeatFresh: true,
    });
  });

  it("blocks stale heartbeat and critical backlog", () => {
    const report = classifyWorkerHealth({
      now: Date.now(),
      heartbeats: [
        {
          service: "api-worker",
          ageMs: WORKER_HEALTH_THRESHOLDS.heartbeatStaleMs + 1,
        },
      ],
      aggregate: { warnings: [], critical: ["queue_backlog"], totals: {} },
    });
    expect(report).toMatchObject({ status: "blocked", heartbeatFresh: false });
  });
});
