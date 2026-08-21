import { beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map();
const redisGet = vi.fn(async (key) => values.get(key) ?? null);
const redisSet = vi.fn(async (key, value) => { values.set(key, value); return true; });
const redisDel = vi.fn(async (key) => { values.delete(key); return true; });

vi.mock("../redis.js", () => ({ redisGet, redisSet, redisDel, redisPing: vi.fn(async () => true) }));

describe("service health recovery", () => {
  beforeEach(() => { values.clear(); vi.clearAllMocks(); });

  it("expires legacy latched failure counters that have no recovery timestamp", async () => {
    values.set("sp:health:failures:openai", "54954");
    const { getServiceStatus } = await import("../domains/billing/serviceHealth.service.js");
    await expect(getServiceStatus("openai")).resolves.toBe("healthy");
    expect(redisDel).toHaveBeenCalledWith("sp:health:failures:openai");
  });

  it("stores new failures in a bounded recovery window", async () => {
    const { recordServiceFailure } = await import("../domains/billing/serviceHealth.service.js");
    await recordServiceFailure("openai");
    expect(redisSet).toHaveBeenCalledWith("sp:health:failures:openai", "1", 300);
    expect(redisSet).toHaveBeenCalledWith("sp:health:last_failure:openai", expect.any(String), 300);
  });
});
