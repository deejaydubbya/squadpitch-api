import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProcessRole,
  getProcessRole,
} from "../lib/processRole.js";
import { topologySnapshot } from "../lib/redisTopology.js";
import {
  primeWorkerRegistryForTest,
  resetWorkerRegistryForTest,
  startWorkers,
  stopWorkers,
} from "../workers/index.js";
import { assertRedisTestSafety } from "../redis.js";

describe("Redis process ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetWorkerRegistryForTest();
    delete process.env.PROCESS_ROLE;
  });

  it("defaults application processes to the API role", () => {
    expect(getProcessRole({ NODE_ENV: "production" })).toBe("api");
  });

  it("fails loudly when an API role attempts worker initialization", () => {
    expect(() =>
      assertProcessRole("worker", {
        NODE_ENV: "production",
        PROCESS_ROLE: "api",
      }),
    ).toThrow(/cannot initialize worker-only components/);
  });

  it("allows only the worker role to own the worker topology", () => {
    const worker = topologySnapshot({
      NODE_ENV: "production",
      PROCESS_ROLE: "worker",
    });
    const api = topologySnapshot({
      NODE_ENV: "production",
      PROCESS_ROLE: "api",
    });
    expect(worker.enabled).toBe(true);
    expect(api.enabled).toBe(false);
    expect(worker.components).toHaveLength(20);
    expect(worker.components).toContainEqual({
      queueName: "sp-account-lifecycle",
      componentType: "worker+scheduler",
      cadence: "daily",
    });
    expect(worker.components).toContainEqual({
      queueName: "sp-referral-qualification",
      componentType: "worker+scheduler",
      cadence: "daily",
    });
    expect(worker.components).toContainEqual({
      queueName: "sp-prospect-preparation",
      componentType: "worker",
      cadence: "on demand",
    });
  });

  it("blocks duplicate initialization and closes registered resources", async () => {
    process.env.PROCESS_ROLE = "worker";
    const close = vi.fn(async () => {});
    const primed = primeWorkerRegistryForTest([{ close }]);
    expect(startWorkers()).toBe(primed);
    await stopWorkers();
    expect(close).toHaveBeenCalledOnce();
  });

  it("blocks accidental external Redis use in tests", () => {
    expect(() =>
      assertRedisTestSafety({
        nodeEnv: "test",
        redisUrl: "rediss://example.upstash.io:6379",
        allowExternal: false,
      }),
    ).toThrow(/External Redis is blocked/);
    expect(() =>
      assertRedisTestSafety({
        nodeEnv: "test",
        redisUrl: "redis://localhost:6379",
        allowExternal: false,
      }),
    ).not.toThrow();
  });
});
