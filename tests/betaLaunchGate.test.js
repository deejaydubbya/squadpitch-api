import { describe, expect, it } from "vitest";
import { evaluateBetaLaunchGate } from "../scripts/beta-launch-gate/gate.js";

const completeManualEvidence = Object.fromEntries(
  [
    "BETA_GATE_FRESH_SIGNUP_EVIDENCE",
    "BETA_GATE_FREE_ONBOARDING_EVIDENCE",
    "BETA_GATE_PAID_BILLING_EVIDENCE",
    "BETA_GATE_CUSTOMER_PORTAL_EVIDENCE",
    "BETA_GATE_EMAIL_EVIDENCE",
    "BETA_GATE_SMS_EVIDENCE",
    "BETA_GATE_RESTORE_EVIDENCE",
    "BETA_GATE_SENTRY_EVIDENCE",
    "BETA_GATE_CORE_CONTROLS_EVIDENCE",
    "BETA_GATE_ACCOUNT_LIFECYCLE_EVIDENCE",
    "BETA_GATE_CANARY_EVIDENCE",
  ].map((name) => [name, "recorded-evidence"]),
);

describe("beta launch gate", () => {
  it("does not claim launch readiness without manual evidence", () => {
    const report = evaluateBetaLaunchGate({
      env: {},
      apiRoot: process.cwd(),
      webRoot: process.cwd(),
    });
    expect(report.summary.status).toBe("NOT_READY_EVIDENCE_INCOMPLETE");
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.summary.recoveryPolicy).toEqual({
      controlledBeta: "ALLOWED_WITH_ACCEPTED_WARNING",
      publicAcquisition: "BLOCKED",
    });
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

  it("allows controlled beta but blocks public acquisition for accepted snapshot-only recovery", () => {
    const report = evaluateBetaLaunchGate({
      env: completeManualEvidence,
      apiRoot: process.cwd(),
      webRoot: process.cwd(),
    });
    expect(report.summary.status).toBe(
      "CONTROLLED_BETA_ALLOWED_WITH_ACCEPTED_WARNING",
    );
    expect(report.summary.controlledBeta).toBe("ALLOWED");
    expect(report.summary.publicAcquisition).toBe("BLOCKED");
    expect(report.summary.acceptedWarnings).toBe(1);
    expect(report.summary.recoveryPolicy.controlledBeta).toBe(
      "ALLOWED_WITH_ACCEPTED_WARNING",
    );
  });

  it("blocks controlled beta when snapshot-only recovery was not explicitly accepted", () => {
    const report = evaluateBetaLaunchGate({
      env: completeManualEvidence,
      apiRoot: process.cwd(),
      webRoot: process.cwd(),
      recoveryEvidence: {
        pitrConfirmed: false,
        restoreTestCompleted: true,
        restoreValidationPassed: true,
        snapshotOnlyRecoveryAcceptedForControlledBeta: false,
      },
    });
    expect(report.summary.controlledBeta).toBe("BLOCKED");
    expect(report.summary.publicAcquisition).toBe("BLOCKED");
    expect(report.summary.recoveryPolicy.controlledBeta).toBe("BLOCKED");
  });
});
