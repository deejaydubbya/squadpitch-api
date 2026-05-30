// Phase IG-02 — App Review check now reports
// `instagram_business_manage_insights`, not the legacy
// `instagram_manage_insights`. We don't exercise the live Meta
// call here (covered by the existing dev tooling); we exercise
// only the scope label so a future copy edit doesn't silently
// regress it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInstagramInsightsCheck } from "../domains/studio/metaAppReviewChecks.service.js";

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runInstagramInsightsCheck — scope label", () => {
  it("reports instagram_business_manage_insights when connection is missing", async () => {
    const result = await runInstagramInsightsCheck(null);
    expect(result.scope).toBe("instagram_business_manage_insights");
    expect(result.attempted).toBe(false);
    expect(result.success).toBe(false);
  });

  it("reports instagram_business_manage_insights when externalAccountId is missing", async () => {
    const result = await runInstagramInsightsCheck({
      accessToken: "T",
      externalAccountId: null,
    });
    expect(result.scope).toBe("instagram_business_manage_insights");
  });

  it("never emits the legacy scope name", async () => {
    const result = await runInstagramInsightsCheck(null);
    expect(JSON.stringify(result)).not.toContain("instagram_manage_insights");
  });
});
