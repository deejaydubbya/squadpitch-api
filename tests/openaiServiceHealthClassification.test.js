import { describe, expect, it } from "vitest";
import { isServiceHealthFailure } from "../domains/studio/generation/openai.provider.js";

describe("OpenAI service-health failure classification", () => {
  it("does not trip global health for ordinary request-validation errors", () => {
    expect(isServiceHealthFailure({ status: 400 })).toBe(false);
    expect(isServiceHealthFailure({ status: 404 })).toBe(false);
    expect(isServiceHealthFailure({ status: 422 })).toBe(false);
  });

  it("tracks authentication, throttling, network, and provider failures", () => {
    expect(isServiceHealthFailure({ status: 401 })).toBe(true);
    expect(isServiceHealthFailure({ status: 429 })).toBe(true);
    expect(isServiceHealthFailure({ status: 503 })).toBe(true);
    expect(isServiceHealthFailure(new Error("network"))).toBe(true);
  });
});
