import { describe, expect, it } from "vitest";
import { evaluateBetaLaunchGate } from "../scripts/beta-launch-gate/gate.js";

describe("beta launch gate", () => {
  it("does not claim launch readiness without manual evidence", () => {
    const report = evaluateBetaLaunchGate({ env: {} });
    expect(report.summary.status).toBe("NOT_READY_EVIDENCE_INCOMPLETE");
    expect(report.summary.warn).toBeGreaterThan(0);
  });

  it("fails closed when repository evidence is unavailable", () => {
    const report = evaluateBetaLaunchGate({
      env: {},
      apiRoot: "Z:\\missing-api",
      webRoot: "Z:\\missing-web",
    });
    expect(report.summary.status).toBe("NOT_READY");
    expect(report.summary.fail).toBeGreaterThan(0);
  });
});
