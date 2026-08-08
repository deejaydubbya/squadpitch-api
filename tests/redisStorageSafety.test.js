import { describe, expect, it } from "vitest";
import {
  classifyStorage,
  parseUsedMemory,
  QUEUE_ALLOWLIST,
} from "../scripts/redis-storage/common.js";

describe("Redis 250 MB storage guardrails", () => {
  it.each([
    [0.49, "ok"],
    [0.5, "notice"],
    [0.7, "warning"],
    [0.85, "critical"],
  ])("classifies utilization %s", (ratio, status) => {
    expect(classifyStorage(250 * 1024 * 1024 * ratio).status).toBe(status);
  });

  it("parses only the exact used_memory field", () => {
    expect(parseUsedMemory("used_memory:123\r\nused_memory_peak:999\r\n")).toBe(123);
    expect(parseUsedMemory("used_memory:0\r\n")).toBeNull();
  });

  it("uses a finite explicit queue allowlist", () => {
    expect(QUEUE_ALLOWLIST).toHaveLength(17);
    expect(QUEUE_ALLOWLIST.every((name) => name.startsWith("sp-"))).toBe(true);
    expect(QUEUE_ALLOWLIST).not.toContain("*");
  });
});
