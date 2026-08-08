import { describe, expect, it } from "vitest";
import {
  BOUNDED_JOB_RETENTION,
  CONSERVATIVE_WORKER_OPTIONS,
} from "../lib/bullmqOptions.js";

describe("BullMQ cost and retention policy", () => {
  it("bounds successful and failed job history", () => {
    expect(BOUNDED_JOB_RETENTION.removeOnComplete.count).toBeGreaterThan(0);
    expect(BOUNDED_JOB_RETENTION.removeOnFail.count).toBeGreaterThan(0);
    expect(BOUNDED_JOB_RETENTION.removeOnFail.age).toBeGreaterThan(
      BOUNDED_JOB_RETENTION.removeOnComplete.age,
    );
  });

  it("uses conservative idle and stalled-job settings", () => {
    expect(CONSERVATIVE_WORKER_OPTIONS.drainDelay).toBeGreaterThanOrEqual(10);
    expect(CONSERVATIVE_WORKER_OPTIONS.stalledInterval).toBeLessThanOrEqual(60_000);
    expect(CONSERVATIVE_WORKER_OPTIONS.maxStalledCount).toBeGreaterThan(0);
  });
});
