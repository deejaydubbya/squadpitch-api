// Adapter-timeout regression guard.
//
// `withPublishTimeout` MUST:
//   - resolve with the adapter result when it returns in time
//   - reject with PROVIDER_TIMEOUT (status 504) when the adapter hangs
//   - never block longer than the configured timeoutMs
//   - read from PUBLISH_ADAPTER_TIMEOUT_MS via env, with a sane default

import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { PUBLISH_ADAPTER_TIMEOUT_MS: undefined },
}));

const { withPublishTimeout, getPublishTimeoutMs } = await import(
  "../domains/studio/publishing/publishTimeout.js"
);

describe("getPublishTimeoutMs", () => {
  it("falls back to 45s when env is unset", () => {
    expect(getPublishTimeoutMs()).toBe(45_000);
  });
});

describe("withPublishTimeout", () => {
  it("returns the adapter value when it resolves in time", async () => {
    const fast = Promise.resolve({ externalPostId: "ig_1" });
    await expect(withPublishTimeout(fast, { timeoutMs: 1000 })).resolves.toEqual({
      externalPostId: "ig_1",
    });
  });

  it("rejects with PROVIDER_TIMEOUT when the adapter hangs", async () => {
    // A promise that never resolves — emulates a wedged HTTP call.
    const hang = new Promise(() => {});
    const start = Date.now();
    await expect(
      withPublishTimeout(hang, { timeoutMs: 50, channel: "INSTAGRAM" })
    ).rejects.toMatchObject({
      status: 504,
      code: "PROVIDER_TIMEOUT",
      channel: "INSTAGRAM",
      timeoutMs: 50,
    });
    // Bound: should not have waited materially longer than the configured ms.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("propagates the adapter's own error if it rejects before timeout", async () => {
    const reject = Promise.reject(
      Object.assign(new Error("rate limit"), { status: 429, code: "RATE_LIMITED" })
    );
    await expect(
      withPublishTimeout(reject, { timeoutMs: 1000 })
    ).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });
});
