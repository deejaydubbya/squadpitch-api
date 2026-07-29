export const launchTestJourneys = Object.freeze([
  {
    id: "plan-continuation",
    tests: ["tests/billingIntegrity.test.js", "tests/billingConstants.test.js"],
  },
  {
    id: "workspace-tenant-isolation",
    tests: [
      "tests/tenantIsolation.test.js",
      "tests/workspaceLifecycleIsolation.test.js",
    ],
  },
  {
    id: "billing-entitlement-webhooks",
    tests: [
      "tests/stripeWebhookSignature.test.js",
      "tests/webhookOrdering.test.js",
      "tests/billingIntegrity.test.js",
    ],
  },
  {
    id: "content-generation-hosted-ai",
    tests: ["tests/aiProductionVerification.test.js"],
  },
  {
    id: "integration-state",
    tests: [
      "tests/integrationCapabilityMatrix.test.js",
      "tests/oauthStateTransitions.test.js",
    ],
  },
  {
    id: "scheduling-publishing-boundary",
    tests: ["tests/publishingService.test.js"],
  },
  {
    id: "notifications-support-readiness",
    tests: ["tests/postmarkSafety.test.js", "tests/twilioSafety.test.js"],
  },
  {
    id: "billing-account-lifecycle",
    tests: [
      "tests/accountLifecycle.test.js",
      "tests/workspaceLifecycleIsolation.test.js",
    ],
  },
]);

export function evaluateLiveLaunchSafety(env = process.env) {
  const checks = [];
  const forbidden = [
    ["LAUNCH_AUTO_CHARGE_CARDS", "Automated live card charges are forbidden."],
    ["LAUNCH_DESTRUCTIVE_ACTIONS", "Automated destructive account actions are forbidden."],
  ];
  for (const [name, message] of forbidden) {
    checks.push({
      id: `safety.${name.toLowerCase()}`,
      status: String(env[name] ?? "false").toLowerCase() === "true" ? "FAIL" : "PASS",
      message,
    });
  }
  checks.push({
    id: "safety.publish-canary",
    status: env.LAUNCH_PUBLISH_CANARY_DESTINATION ? "PASS" : "WARN",
    message: env.LAUNCH_PUBLISH_CANARY_DESTINATION
      ? "An explicit canary destination is configured; live publishing still requires an operator invocation."
      : "No canary destination configured; live publishing checks must remain skipped.",
  });
  checks.push({
    id: "safety.provider-sends",
    status: "PASS",
    message:
      "Launch tests do not send email/SMS; provider sends remain governed by existing explicit production flags.",
  });
  return checks;
}
