import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  integrationCapabilityMatrix,
  validateIntegrationCapabilityMatrix,
} from "../../domains/integrations/integrationCapabilityMatrix.js";
import backupRecoveryEvidence from "../backup-recovery/evidence.json" with { type: "json" };

const manualCriteria = Object.freeze([
  ["fresh-signup", "BETA_GATE_FRESH_SIGNUP_EVIDENCE"],
  ["free-onboarding-first-value", "BETA_GATE_FREE_ONBOARDING_EVIDENCE"],
  ["paid-checkout-webhook-entitlement", "BETA_GATE_PAID_BILLING_EVIDENCE"],
  ["customer-portal", "BETA_GATE_CUSTOMER_PORTAL_EVIDENCE"],
  ["email-delivery", "BETA_GATE_EMAIL_EVIDENCE"],
  ["sms-compliance-or-unavailable", "BETA_GATE_SMS_EVIDENCE"],
  ["backup-and-restore", "BETA_GATE_RESTORE_EVIDENCE"],
  ["sentry-alert-delivery", "BETA_GATE_SENTRY_EVIDENCE"],
  ["core-control-walkthrough", "BETA_GATE_CORE_CONTROLS_EVIDENCE"],
  ["account-lifecycle", "BETA_GATE_ACCOUNT_LIFECYCLE_EVIDENCE"],
  ["production-canary", "BETA_GATE_CANARY_EVIDENCE"],
]);

export function evaluateBetaLaunchGate({
  env = process.env,
  apiRoot = resolve("."),
  webRoot = resolve("..", "squadpitch-web"),
  recoveryEvidence = backupRecoveryEvidence,
} = {}) {
  const results = [
    automated(
      "automated.production-verifier",
      packageHasScript(apiRoot, "verify:production"),
      "Production verifier command exists.",
    ),
    automated(
      "automated.launch-suite",
      packageHasScript(apiRoot, "test:launch") &&
        packageHasScript(webRoot, "test:launch"),
      "API and web launch commands exist.",
    ),
    automated(
      "automated.tenant-isolation",
      existsSync(resolve(apiRoot, "tests", "tenantIsolation.test.js")) &&
        existsSync(
          resolve(apiRoot, "tests", "workspaceLifecycleIsolation.test.js"),
        ),
      "Tenant and lifecycle isolation regression suites exist.",
    ),
    automated(
      "automated.integration-labels",
      validateIntegrationCapabilityMatrix(integrationCapabilityMatrix)
        .length === 0,
      "Integration capability labels are approval-gated.",
    ),
    automated(
      "automated.no-demo-publish",
      !existsSync(
        resolve(
          apiRoot,
          "domains",
          "studio",
          "publishing",
          "metaDemoPublish.js",
        ),
      ) &&
        !read(
          resolve(
            apiRoot,
            "domains",
            "studio",
            "publishing",
            "publishingService.js",
          ),
        ).includes("simulateMetaDemoPublish"),
      "Synthetic Meta publish path is absent from production publishing.",
    ),
    automated(
      "automated.no-legacy-admin-allowlist",
      !existsSync(resolve(apiRoot, "middleware", "requireAdmin.js")) &&
        !read(resolve(apiRoot, "config", "env.js")).includes("ADMIN_USER_IDS"),
      "Authorization no longer exposes the legacy environment allowlist middleware.",
    ),
    recoveryPolicy(recoveryEvidence),
  ];

  for (const [id, variable] of manualCriteria) {
    const present =
      typeof env[variable] === "string" && env[variable].trim() !== "";
    results.push({
      id: `manual.${id}`,
      status: present ? "PASS" : "WARN",
      message: present
        ? `Evidence reference supplied via ${variable}.`
        : `Manual evidence not supplied; record a reference in ${variable}.`,
    });
  }

  const counts = Object.fromEntries(
    ["PASS", "WARN", "FAIL"].map((status) => [
      status.toLowerCase(),
      results.filter((item) => item.status === status).length,
    ]),
  );
  const acceptedWarnings = results.filter(
    (item) => item.status === "WARN" && item.acceptedWarning,
  ).length;
  const incompleteWarnings = counts.warn - acceptedWarnings;
  const controlledBetaAllowed = counts.fail === 0 && incompleteWarnings === 0;
  const publicAcquisitionAllowed =
    controlledBetaAllowed && recoveryEvidence.pitrConfirmed === true;
  const snapshotRecoveryAccepted = results.some(
    (item) =>
      item.id === "automated.backup-recovery-policy" &&
      (item.status === "PASS" || item.acceptedWarning),
  );
  return {
    schemaVersion: "beta-launch-gate.v2",
    generatedAt: new Date().toISOString(),
    summary: {
      status: counts.fail
        ? "NOT_READY"
        : incompleteWarnings
          ? "NOT_READY_EVIDENCE_INCOMPLETE"
          : acceptedWarnings
            ? "CONTROLLED_BETA_ALLOWED_WITH_ACCEPTED_WARNING"
            : "READY_FOR_CONTROLLED_BETA",
      controlledBeta: controlledBetaAllowed ? "ALLOWED" : "BLOCKED",
      publicAcquisition: publicAcquisitionAllowed ? "ALLOWED" : "BLOCKED",
      recoveryPolicy: {
        controlledBeta: snapshotRecoveryAccepted
          ? recoveryEvidence.pitrConfirmed
            ? "ALLOWED"
            : "ALLOWED_WITH_ACCEPTED_WARNING"
          : "BLOCKED",
        publicAcquisition:
          recoveryEvidence.pitrConfirmed === true ? "ALLOWED" : "BLOCKED",
      },
      acceptedWarnings,
      incompleteWarnings,
      ...counts,
    },
    results,
  };
}

function recoveryPolicy(evidence) {
  if (evidence?.pitrConfirmed === true) {
    return {
      id: "automated.backup-recovery-policy",
      status: "PASS",
      acceptedWarning: false,
      message: "PITR is confirmed for public acquisition.",
    };
  }
  if (
    evidence?.restoreTestCompleted === true &&
    evidence?.restoreValidationPassed === true &&
    evidence?.snapshotOnlyRecoveryAcceptedForControlledBeta === true
  ) {
    return {
      id: "automated.backup-recovery-policy",
      status: "WARN",
      acceptedWarning: true,
      message: evidence.acceptedWarning,
    };
  }
  return {
    id: "automated.backup-recovery-policy",
    status: "FAIL",
    acceptedWarning: false,
    message:
      "Neither PITR nor an explicitly accepted, proven snapshot-restore policy is present.",
  };
}

function automated(id, pass, message) {
  return { id, status: pass ? "PASS" : "FAIL", message };
}

function packageHasScript(root, name) {
  try {
    const pkg = JSON.parse(read(resolve(root, "package.json")));
    return typeof pkg.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
