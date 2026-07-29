import { describe, expect, it } from "vitest";
import {
  evaluateLiveLaunchSafety,
  launchTestJourneys,
} from "../scripts/launch-tests/manifest.js";

describe("launch test manifest", () => {
  it("covers every server-side launch boundary", () => {
    expect(launchTestJourneys.map((journey) => journey.id)).toEqual([
      "plan-continuation",
      "workspace-tenant-isolation",
      "billing-entitlement-webhooks",
      "content-generation-hosted-ai",
      "integration-state",
      "scheduling-publishing-boundary",
      "notifications-support-readiness",
      "billing-account-lifecycle",
    ]);
  });

  it("warns and skips publishing without an explicit canary", () => {
    expect(
      evaluateLiveLaunchSafety({}).find(
        (check) => check.id === "safety.publish-canary",
      ),
    ).toMatchObject({ status: "WARN" });
  });

  it("fails forbidden charge and destructive switches", () => {
    const checks = evaluateLiveLaunchSafety({
      LAUNCH_AUTO_CHARGE_CARDS: "true",
      LAUNCH_DESTRUCTIVE_ACTIONS: "TRUE",
    });
    expect(checks.filter((check) => check.status === "FAIL")).toHaveLength(2);
  });
});
