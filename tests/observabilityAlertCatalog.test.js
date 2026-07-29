import { describe, expect, it } from "vitest";
import {
  launchAlertCatalog,
  validateLaunchAlertCatalog,
} from "../scripts/observability/alertCatalog.js";

describe("launch alert catalog", () => {
  it("is complete and valid", () => {
    expect(validateLaunchAlertCatalog()).toEqual([]);
    expect(launchAlertCatalog).toHaveLength(12);
  });

  it("covers every launch-critical failure family", () => {
    const ids = launchAlertCatalog.map(([id]) => id);
    expect(ids).toEqual(expect.arrayContaining([
      "api.5xx-rate", "auth.failure-spike", "stripe.checkout-failure",
      "stripe.webhook-failure", "queue.worker-failure", "publish.failure-rate",
      "database.unavailable", "postmark.delivery-failure",
      "twilio.delivery-failure", "oauth.refresh-failure",
      "ai.hosted-outage", "ai.abnormal-fallback-rate",
    ]));
  });
});
