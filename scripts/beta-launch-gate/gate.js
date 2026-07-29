import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  integrationCapabilityMatrix,
  validateIntegrationCapabilityMatrix,
} from "../../domains/integrations/integrationCapabilityMatrix.js";

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
        existsSync(resolve(apiRoot, "tests", "workspaceLifecycleIsolation.test.js")),
      "Tenant and lifecycle isolation regression suites exist.",
    ),
    automated(
      "automated.integration-labels",
      validateIntegrationCapabilityMatrix(integrationCapabilityMatrix).length === 0,
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
        !read(resolve(apiRoot, "domains", "studio", "publishing", "publishingService.js"))
          .includes("simulateMetaDemoPublish"),
      "Synthetic Meta publish path is absent from production publishing.",
    ),
    automated(
      "automated.no-legacy-admin-allowlist",
      !existsSync(resolve(apiRoot, "middleware", "requireAdmin.js")) &&
        !read(resolve(apiRoot, "config", "env.js")).includes("ADMIN_USER_IDS"),
      "Authorization no longer exposes the legacy environment allowlist middleware.",
    ),
  ];

  for (const [id, variable] of manualCriteria) {
    const present = typeof env[variable] === "string" && env[variable].trim() !== "";
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
  return {
    schemaVersion: "beta-launch-gate.v1",
    generatedAt: new Date().toISOString(),
    summary: {
      status: counts.fail
        ? "NOT_READY"
        : counts.warn
          ? "NOT_READY_EVIDENCE_INCOMPLETE"
          : "READY_FOR_CONTROLLED_BETA",
      ...counts,
    },
    results,
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
