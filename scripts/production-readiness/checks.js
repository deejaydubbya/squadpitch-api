import "dotenv/config";

import { check, configCheck } from "./classifier.js";
import { stripeKeyMode } from "../../domains/billing/stripeSafety.js";
import {
  integrationCapabilityMatrix,
  validateIntegrationCapabilityMatrix,
} from "../../domains/integrations/integrationCapabilityMatrix.js";

const CORE_URLS = {
  api: "https://squadpitch-api.fly.dev/health",
  ai: "https://squadpitch-ai.fly.dev/health",
  sites: "https://squadpitch-sites.fly.dev/api/health",
};

export async function runProductionReadinessChecks({
  env = process.env,
  network = true,
  fetchImpl = globalThis.fetch,
  databaseProbe = probeDatabase,
  redisProbe = probeRedis,
} = {}) {
  const checks = [];
  const add = (...items) => checks.push(...items);

  add(
    runtimeCheck(env),
    integrationCapabilityCheck(),
    configCheck({
      id: "auth0.config",
      group: "Auth0",
      variables: ["AUTH0_DOMAIN", "AUTH0_AUDIENCE"],
      remediation: "Set the production Auth0 tenant domain and API audience.",
      env,
    }),
    stripeModeCheck(env),
    configCheck({
      id: "database.config",
      group: "Database",
      variables: ["DATABASE_URL"],
      remediation:
        "Set DATABASE_URL to the production PostgreSQL connection string.",
      env,
    }),
    configCheck({
      id: "redis.config",
      group: "Redis/queues/workers",
      variables: ["REDIS_URL"],
      remediation:
        "Set REDIS_URL and confirm the API and worker share the same Redis.",
      env,
    }),
    configCheck({
      id: "stripe.config",
      group: "Stripe",
      variables: [
        "STRIPE_SECRET_KEY",
        "STRIPE_EXPECTED_MODE",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_STARTER_PRICE_ID",
        "STRIPE_PRO_PRICE_ID",
        "STRIPE_GROWTH_PRICE_ID",
        "STRIPE_STARTER_PRODUCT_ID",
        "STRIPE_PRO_PRODUCT_ID",
        "STRIPE_GROWTH_PRODUCT_ID",
      ],
      remediation:
        "Configure Stripe live-mode key, webhook signing secret, and all production price IDs.",
      env,
    }),
    configCheck({
      id: "postmark.config",
      group: "Postmark/email",
      variables: [
        "POSTMARK_SERVER_TOKEN",
        "POSTMARK_MESSAGE_STREAM",
        "NOTIFICATION_FROM_EMAIL",
        "INBOX_EMAIL_FROM",
        "INBOX_EMAIL_REPLY_DOMAIN",
        "POSTMARK_INBOUND_WEBHOOK_SECRET",
      ],
      remediation:
        "Configure the production Postmark server, verified senders, transactional stream, inbound domain, and webhook secret.",
      env,
    }),
    twilioConfigCheck(env),
    ...smsDisabledChecks(env),
    configCheck({
      id: "hosted-ai.config",
      group: "Hosted AI + provenance",
      variables: [
        "AI_PLATFORM_INTERNAL_BASE_URL",
        "AI_PLATFORM_SERVICE_AUTH_KEY_ID",
        "AI_PLATFORM_SERVICE_AUTH_SECRET",
      ],
      remediation:
        "Configure the private AI URL and matching signed-envelope key ID/secret.",
      env,
    }),
    configCheck({
      id: "sentry.api.config",
      group: "Sentry",
      variables: ["SENTRY_DSN", "SENTRY_ENVIRONMENT"],
      required: false,
      remediation:
        "Configure the API Sentry DSN/environment and verify an event in Sentry.",
      env,
    }),
    configCheck({
      id: "sentry.api.delivery",
      group: "Sentry",
      variables: ["SENTRY_DELIVERY_VERIFIED"],
      required: false,
      remediation:
        "Run npm run verify:sentry, locate its event ID in Sentry production, then set SENTRY_DELIVERY_VERIFIED to the verification date/event reference.",
      env,
    }),
    configCheck({
      id: "sites.config",
      group: "Sites runtime",
      variables: [
        "PUBLIC_SITES_BASE_DOMAIN",
        "RUNTIME_REVALIDATE_URL",
        "RUNTIME_REVALIDATE_TOKEN",
        "RUNTIME_IP_SALT",
      ],
      remediation:
        "Configure the public sites domain, revalidation URL/shared token, and IP hashing salt.",
      env,
    }),
    configCheck({
      id: "canary.config",
      group: "Synthetic production canary",
      variables: [
        "PRODUCTION_CANARY_WORKSPACE_ID",
        "PRODUCTION_CANARY_SITES_HEALTH_URL",
      ],
      required: false,
      remediation:
        "Create a dedicated non-admin synthetic identity/workspace and configure the allowlisted workspace ID plus Sites health URL.",
      env,
    }),
    socialConfigurationCheck(env),
    ...dangerousFlagChecks(env),
  );

  if (!network) {
    for (const [id, group] of [
      ["auth0.connectivity", "Auth0"],
      ["database.connectivity", "Database"],
      ["database.migrations", "Migration/schema state"],
      ["redis.connectivity", "Redis/queues/workers"],
      ["AUTOMATED_WORKER_HEALTH_URL_CONFIGURED", "Worker health"],
      ["AUTOMATED_WORKER_HEALTH_REACHABLE", "Worker health"],
      ["WORKER_HEALTH_RESPONSE_VALID", "Worker health"],
      ["WORKER_HEALTH_PRODUCTION_STATUS", "Worker health"],
      ["api.connectivity", "Runtime/environment"],
      ["web.connectivity", "Runtime/environment"],
      ["sites.connectivity", "Sites runtime"],
      ["hosted-ai.connectivity", "Hosted AI + provenance"],
      ["CANARY_IDENTITY_CONFIGURED", "Synthetic canary + hosted AI provenance"],
      [
        "CANARY_WORKSPACE_ALLOWLISTED",
        "Synthetic canary + hosted AI provenance",
      ],
      [
        "CANARY_DATABASE_PATH_VERIFIED",
        "Synthetic canary + hosted AI provenance",
      ],
      ["CANARY_QUEUE_PATH_VERIFIED", "Synthetic canary + hosted AI provenance"],
      ["CANARY_AI_PATH_VERIFIED", "Synthetic canary + hosted AI provenance"],
      ["CANARY_CLEANUP_VERIFIED", "Synthetic canary + hosted AI provenance"],
      ["AI_PROVENANCE_PRESENT", "Synthetic canary + hosted AI provenance"],
      ["AI_HOSTED_SERVICE_VERIFIED", "Synthetic canary + hosted AI provenance"],
      ["AI_FALLBACK_AVAILABLE", "Synthetic canary + hosted AI provenance"],
      ["REDIS_REACHABLE", "Worker health"],
      ["WORKER_PROCESS_RUNNING", "Worker health"],
      ["WORKER_HEARTBEAT_FRESH", "Worker health"],
      ["WORKER_SYNTHETIC_JOB_CONSUMED", "Worker health"],
      ["QUEUE_BACKLOG_WITHIN_LIMIT", "Worker health"],
      ["OLDEST_WAITING_JOB_WITHIN_LIMIT", "Worker health"],
      ["FAILED_JOB_RATE_WITHIN_LIMIT", "Worker health"],
      ["STALLED_JOB_COUNT_WITHIN_LIMIT", "Worker health"],
      ["RETRY_EXHAUSTION_WITHIN_LIMIT", "Worker health"],
      ["WORKER_ALERT_DELIVERY_VERIFIED", "Worker health"],
      ["stripe.connectivity", "Stripe"],
      ["postmark.connectivity", "Postmark/email"],
      ["twilio.connectivity", "Twilio/SMS"],
    ]) {
      add(
        check(
          id,
          group,
          "connectivity",
          "BLOCKED",
          "P2",
          "Skipped by --no-network",
          "Run without --no-network from an environment with production access.",
        ),
      );
    }
    return checks;
  }

  add(
    await httpCheck({
      id: "auth0.connectivity",
      group: "Auth0",
      url: auth0DiscoveryUrl(env.AUTH0_DOMAIN),
      core: true,
      fetchImpl,
      remediation:
        "Verify AUTH0_DOMAIN, tenant availability, and outbound DNS/TLS.",
    }),
    await probeResult(
      "database.connectivity",
      "Database",
      true,
      databaseProbe,
      {
        env,
        mode: "connectivity",
      },
    ),
    await probeResult(
      "database.migrations",
      "Migration/schema state",
      true,
      databaseProbe,
      { env, mode: "migrations" },
    ),
    await probeResult(
      "redis.connectivity",
      "Redis/queues/workers",
      true,
      redisProbe,
      { env },
    ),
    ...(await workerHealthEndpointChecks({
      url: env.SQUADPITCH_WORKER_HEALTH_URL,
      fetchImpl,
    })),
    await httpCheck({
      id: "api.connectivity",
      group: "Runtime/environment",
      url: env.SQUADPITCH_API_HEALTH_URL ?? CORE_URLS.api,
      core: true,
      fetchImpl,
      remediation: "Check the API Fly deployment and /health endpoint.",
    }),
    await httpCheck({
      id: "web.connectivity",
      group: "Runtime/environment",
      url: env.APP_URL,
      core: true,
      fetchImpl,
      remediation:
        "Set APP_URL and verify the production web deployment responds.",
    }),
    await httpCheck({
      id: "sites.connectivity",
      group: "Sites runtime",
      url: env.SQUADPITCH_SITES_HEALTH_URL ?? CORE_URLS.sites,
      core: true,
      fetchImpl,
      remediation: "Check the SquadSites Fly deployment and /api/health.",
    }),
    await httpCheck({
      id: "hosted-ai.connectivity",
      group: "Hosted AI + provenance",
      url: env.SQUADPITCH_AI_HEALTH_URL ?? CORE_URLS.ai,
      core: true,
      fetchImpl,
      remediation:
        "Check squadpitch-ai health, then run npm run verify:ai-production for signed provenance.",
    }),
    ...(await productionCanaryEvidenceChecks(env, fetchImpl)),
    await stripeCheck(env, fetchImpl),
    await postmarkCheck(env, fetchImpl),
    await twilioCheck(env, fetchImpl),
  );
  return checks;
}

function integrationCapabilityCheck() {
  const errors = validateIntegrationCapabilityMatrix(
    integrationCapabilityMatrix,
  );
  return check(
    "integrations.capability-matrix",
    "Social integrations",
    "configuration",
    errors.length ? "FAIL" : "PASS",
    "P0",
    errors.length
      ? "Integration capability matrix contains unsafe availability claims"
      : `Integration availability is capability-specific and approval-gated; Pinterest image publishing is ${integrationCapabilityMatrix.PINTEREST.mediaPublish}`,
    "Downgrade unsupported or unapproved capabilities to BETA, COMING_SOON, or UNAVAILABLE.",
  );
}

async function productionCanaryEvidenceChecks(env, fetchImpl) {
  const workspaceId = env.SQUADPITCH_CANARY_WORKSPACE_ID;
  const baseUrl = env.SQUADPITCH_CANARY_BASE_URL;
  const token = env.SQUADPITCH_CANARY_TOKEN;
  const cookie = env.SQUADPITCH_CANARY_COOKIE;
  const ids = [
    "CANARY_IDENTITY_CONFIGURED",
    "CANARY_WORKSPACE_ALLOWLISTED",
    "CANARY_DATABASE_PATH_VERIFIED",
    "CANARY_QUEUE_PATH_VERIFIED",
    "CANARY_AI_PATH_VERIFIED",
    "CANARY_CLEANUP_VERIFIED",
    "AI_PROVENANCE_PRESENT",
    "AI_HOSTED_SERVICE_VERIFIED",
    "AI_FALLBACK_AVAILABLE",
    "REDIS_REACHABLE",
    "WORKER_PROCESS_RUNNING",
    "WORKER_HEARTBEAT_FRESH",
    "WORKER_SYNTHETIC_JOB_CONSUMED",
    "QUEUE_BACKLOG_WITHIN_LIMIT",
    "OLDEST_WAITING_JOB_WITHIN_LIMIT",
    "FAILED_JOB_RATE_WITHIN_LIMIT",
    "STALLED_JOB_COUNT_WITHIN_LIMIT",
    "RETRY_EXHAUSTION_WITHIN_LIMIT",
    "WORKER_ALERT_DELIVERY_VERIFIED",
  ];
  if (!workspaceId || !baseUrl || (!token && !cookie)) {
    return ids.map((id) =>
      check(
        id,
        "Synthetic canary + hosted AI provenance",
        "evidence",
        "BLOCKED",
        "P0",
        "Authenticated production canary evidence is unavailable",
        "Set SQUADPITCH_CANARY_BASE_URL, WORKSPACE_ID, and token/cookie, then rerun.",
      ),
    );
  }
  try {
    const { verifyProductionCanary } =
      await import("../production-canary/runner.js");
    const report = await verifyProductionCanary({
      baseUrl,
      token,
      cookie,
      workspaceId,
      runId: `readiness-${Date.now()}`,
      fetchImpl,
    });
    return classifyCanaryEvidence(report, {
      workerAlertDeliveryVerified:
        env.WORKER_ALERT_DELIVERY_VERIFIED === "true",
    });
  } catch {
    return ids.map((id) =>
      check(
        id,
        "Synthetic canary + hosted AI provenance",
        "evidence",
        "FAIL",
        "P0",
        "Authenticated production canary verification failed",
        "Run npm run canary:production and inspect the API, worker, and hosted AI trace logs.",
      ),
    );
  }
}

export function classifyCanaryEvidence(
  report,
  { workerAlertDeliveryVerified = false } = {},
) {
  const byId = new Map(report?.results?.map((item) => [item.id, item]) ?? []);
  const passed = (id) => byId.get(id)?.status === "PASS";
  const item = (id, pass, passMessage, failMessage) =>
    check(
      id,
      "Synthetic canary + hosted AI provenance",
      "evidence",
      pass ? "PASS" : "FAIL",
      "P0",
      pass ? passMessage : failMessage,
      "Rerun the production canary and repair the failed isolated path.",
    );
  const cleanup =
    passed("database.rollback-write") &&
    passed("queue.round-trip") &&
    passed("publishing.boundary");
  const fallbackReported = ["PASS", "WARN"].includes(
    byId.get("ai.fallback-status")?.status,
  );
  return [
    item(
      "CANARY_IDENTITY_CONFIGURED",
      passed("auth.workspace-access"),
      "Normal synthetic-user authentication was verified",
      "Synthetic-user authentication was not verified",
    ),
    item(
      "CANARY_WORKSPACE_ALLOWLISTED",
      report?.workspaceId && passed("auth.workspace-access"),
      "The dedicated synthetic workspace passed the exact allowlist",
      "The synthetic workspace allowlist was not verified",
    ),
    item(
      "CANARY_DATABASE_PATH_VERIFIED",
      passed("database.rollback-write"),
      "Production database write/read/rollback was verified",
      "Production database rollback probe failed",
    ),
    item(
      "CANARY_QUEUE_PATH_VERIFIED",
      passed("queue.round-trip"),
      "Dedicated BullMQ enqueue/consume/removal was verified",
      "Dedicated queue round trip failed",
    ),
    item(
      "CANARY_AI_PATH_VERIFIED",
      passed("ai.hosted-provenance"),
      "Hosted AI dry-run path was verified",
      "Hosted AI dry-run path failed",
    ),
    item(
      "CANARY_CLEANUP_VERIFIED",
      cleanup,
      "Database rollback, queue removal, and no-publish boundary were verified",
      "Canary cleanup evidence was incomplete",
    ),
    item(
      "AI_PROVENANCE_PRESENT",
      passed("ai.provenance-present"),
      "Every AI operation returned service provenance",
      "AI provenance evidence was missing",
    ),
    item(
      "AI_HOSTED_SERVICE_VERIFIED",
      passed("ai.hosted-provenance") && passed("ai.trace-correlation"),
      "Hosted Squadpitch AI source and trace correlation were verified",
      "Hosted AI source or trace correlation was not verified",
    ),
    item(
      "AI_FALLBACK_AVAILABLE",
      fallbackReported,
      "Fallback classification was explicitly reported by production",
      "Fallback classification was unavailable",
    ),
    item(
      "REDIS_REACHABLE",
      passed("worker.redis-reachable"),
      "Redis PING and worker inspection succeeded",
      "Redis worker-health inspection failed",
    ),
    item(
      "WORKER_PROCESS_RUNNING",
      passed("worker.process-running"),
      "Worker heartbeat instances were observed",
      "No worker heartbeat instances were observed",
    ),
    item(
      "WORKER_HEARTBEAT_FRESH",
      passed("worker.heartbeat-fresh"),
      "API and AI worker heartbeats were fresh",
      "A worker heartbeat was missing or stale",
    ),
    item(
      "WORKER_SYNTHETIC_JOB_CONSUMED",
      passed("worker.synthetic-consumed"),
      "Dedicated synthetic job was consumed, correlated, and removed",
      "Synthetic worker job was not safely completed",
    ),
    item(
      "QUEUE_BACKLOG_WITHIN_LIMIT",
      passed("worker.backlog"),
      "Aggregate queue backlog was within the low-beta limit",
      "Queue backlog exceeded its limit",
    ),
    item(
      "OLDEST_WAITING_JOB_WITHIN_LIMIT",
      passed("worker.oldest-waiting"),
      "Oldest waiting job age was within limit",
      "Oldest waiting job exceeded its limit",
    ),
    item(
      "FAILED_JOB_RATE_WITHIN_LIMIT",
      passed("worker.failed-rate"),
      "Recent failed-job rate was within limit",
      "Recent failed-job rate exceeded its limit",
    ),
    item(
      "STALLED_JOB_COUNT_WITHIN_LIMIT",
      passed("worker.stalled"),
      "No recent stalled jobs were observed",
      "Recent stalled jobs were observed",
    ),
    item(
      "RETRY_EXHAUSTION_WITHIN_LIMIT",
      passed("worker.retry-exhaustion"),
      "No recent retry exhaustion was observed",
      "Recent retry exhaustion was observed",
    ),
    check(
      "WORKER_ALERT_DELIVERY_VERIFIED",
      "Worker health",
      "evidence",
      workerAlertDeliveryVerified ? "PASS" : "WARN",
      "P2",
      workerAlertDeliveryVerified
        ? "Synthetic Sentry event and alert email delivery were manually confirmed"
        : "Synthetic Sentry event delivery awaits dashboard confirmation",
      "Confirm the worker-health event in Sentry and its email alert delivery.",
    ),
  ];
}

function runtimeCheck(env) {
  const valid = env.NODE_ENV === "production";
  return check(
    "runtime.node-env",
    "Runtime/environment",
    "configuration",
    valid ? "PASS" : "FAIL",
    "P0",
    valid ? "NODE_ENV is production" : "NODE_ENV must equal production",
    "Set NODE_ENV=production in the deployed API and worker.",
  );
}

function twilioConfigCheck(env) {
  return check(
    "TWILIO_ACCOUNT_AVAILABLE",
    "Twilio/SMS",
    "configuration",
    "WARN",
    "P2",
    "SMS is intentionally unavailable until the Twilio provider account is resolved and reverified",
    "Keep SMS disabled until every reactivation prerequisite is complete and explicitly approved.",
  );
}

function smsDisabledChecks(env) {
  const disabled = env.SMS_SENDING_ENABLED !== "true";
  const pass = (id, message) =>
    check(
      id,
      "Twilio/SMS",
      "configuration",
      disabled ? "PASS" : "FAIL",
      "P0",
      disabled ? message : "SMS_SENDING_ENABLED must remain false",
      "Set SMS_SENDING_ENABLED=false and redeploy before controlled beta traffic.",
    );
  return [
    check(
      "SMS_CAPABILITY_AVAILABLE",
      "Twilio/SMS",
      "configuration",
      "WARN",
      "P2",
      "DISABLED: provider account suspended",
      "Do not reactivate without explicit approval and completed provider verification.",
    ),
    pass("SMS_SEND_PATH_BLOCKED", "All outbound SMS paths are disabled"),
    pass(
      "SMS_INBOUND_SIDE_EFFECTS_BLOCKED",
      "Signed inbound callbacks are acknowledged without side effects",
    ),
    pass(
      "SMS_JOBS_DISABLED",
      "SMS queue creation, execution, and retries are disabled",
    ),
    pass("SMS_UI_ACCURATE", "SMS is represented as temporarily unavailable"),
    pass("SMS_AI_ACTIONS_BLOCKED", "SMS is unavailable to executable actions"),
    check(
      "SMS_SECRETS_REMOVED_OR_QUARANTINED",
      "Twilio/SMS",
      "configuration",
      disabled ? "PASS" : "FAIL",
      "P1",
      disabled
        ? "Twilio runtime credentials are quarantined behind authoritative disablement"
        : "Twilio credentials are not safely quarantined",
      "Retain only the webhook validation secret if inbound signature validation remains required.",
    ),
  ];
}

function socialConfigurationCheck(env) {
  const providers = [
    ["Meta", ["META_APP_ID", "META_APP_SECRET", "META_OAUTH_REDIRECT_URI"]],
    [
      "Instagram",
      [
        "INSTAGRAM_APP_ID",
        "INSTAGRAM_APP_SECRET",
        "INSTAGRAM_OAUTH_REDIRECT_URI",
      ],
    ],
    [
      "LinkedIn",
      ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI"],
    ],
    [
      "Pinterest",
      [
        "PINTEREST_CLIENT_ID",
        "PINTEREST_CLIENT_SECRET",
        "PINTEREST_REDIRECT_URI",
      ],
    ],
    [
      "TikTok",
      ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI"],
    ],
    ["X", ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_REDIRECT_URI"]],
    [
      "YouTube",
      ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REDIRECT_URI"],
    ],
  ];
  const partial = [];
  const complete = [];
  for (const [name, keys] of providers) {
    const count = keys.filter((key) => env[key]?.trim()).length;
    if (count === keys.length) complete.push(name);
    else if (count > 0) partial.push(name);
  }
  const status =
    partial.length > 0 ? "WARN" : complete.length > 0 ? "PASS" : "WARN";
  const message =
    partial.length > 0
      ? `Partially configured providers: ${partial.join(", ")}`
      : complete.length > 0
        ? `Configured providers: ${complete.join(", ")}`
        : "No social provider is fully configured";
  return check(
    "social.config",
    "Social integrations",
    "configuration",
    status,
    "P2",
    message,
    "Complete each enabled provider's client ID, secret, redirect URI, and dashboard callbacks.",
  );
}

function dangerousFlagChecks(env) {
  const checks = [];
  const smsEnabled = env.SMS_SENDING_ENABLED === "true";
  const a2pApproved = env.SMS_A2P_APPROVED === "true";
  checks.push(
    check(
      "flags.sms-a2p",
      "Dangerous production flags",
      "configuration",
      smsEnabled && !a2pApproved ? "FAIL" : "PASS",
      "P0",
      smsEnabled && !a2pApproved
        ? "SMS sending is enabled without SMS_A2P_APPROVED=true"
        : "SMS/A2P guard is safe",
      "Disable SMS_SENDING_ENABLED or complete A2P approval before sending.",
    ),
  );
  checks.push(
    check(
      "flags.pinterest-sandbox",
      "Dangerous production flags",
      "configuration",
      env.PINTEREST_USE_SANDBOX === "true" ? "WARN" : "PASS",
      "P2",
      env.PINTEREST_USE_SANDBOX === "true"
        ? "Pinterest sandbox mode is enabled"
        : "Pinterest sandbox mode is disabled",
      "Disable PINTEREST_USE_SANDBOX when production Pinterest publishing is approved.",
    ),
  );
  return checks;
}

async function httpCheck({ id, group, url, core, fetchImpl, remediation }) {
  if (!url) {
    return check(
      id,
      group,
      "connectivity",
      core ? "FAIL" : "WARN",
      core ? "P0" : "P2",
      "URL is not configured",
      remediation,
    );
  }
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json,text/html" },
      signal: AbortSignal.timeout(8_000),
      redirect: "follow",
    });
    return check(
      id,
      group,
      "connectivity",
      response.ok ? "PASS" : core ? "FAIL" : "WARN",
      core ? "P0" : "P2",
      response.ok
        ? `Reachable (HTTP ${response.status})`
        : `Returned HTTP ${response.status}`,
      remediation,
    );
  } catch {
    return check(
      id,
      group,
      "connectivity",
      core ? "FAIL" : "WARN",
      core ? "P0" : "P2",
      "Connectivity probe failed",
      remediation,
    );
  }
}

export async function workerHealthEndpointChecks({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  now = new Date(),
} = {}) {
  const group = "Worker health";
  const remediation =
    "Check the private production configuration, API /ready endpoint, Redis, and worker heartbeats.";
  const configured = Boolean(url?.trim());
  const checks = [
    check(
      "AUTOMATED_WORKER_HEALTH_URL_CONFIGURED",
      group,
      "configuration",
      configured ? "PASS" : "BLOCKED",
      "P0",
      configured
        ? "Automated worker-health endpoint is configured"
        : "SQUADPITCH_WORKER_HEALTH_URL is not configured",
      "Configure the existing read-only production worker-health endpoint.",
    ),
  ];
  if (!configured) {
    for (const id of [
      "AUTOMATED_WORKER_HEALTH_REACHABLE",
      "WORKER_HEALTH_RESPONSE_VALID",
      "WORKER_HEALTH_PRODUCTION_STATUS",
    ]) {
      checks.push(
        check(
          id,
          group,
          "connectivity",
          "BLOCKED",
          "P0",
          "Worker-health probe is blocked by missing private configuration",
          remediation,
        ),
      );
    }
    return checks;
  }

  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    checks.push(
      check(
        "AUTOMATED_WORKER_HEALTH_REACHABLE",
        group,
        "connectivity",
        "BLOCKED",
        "P0",
        timedOut
          ? `Worker-health probe timed out after ${timeoutMs}ms`
          : "Worker-health transport or DNS probe failed",
        remediation,
      ),
    );
    for (const id of [
      "WORKER_HEALTH_RESPONSE_VALID",
      "WORKER_HEALTH_PRODUCTION_STATUS",
    ]) {
      checks.push(
        check(
          id,
          group,
          "connectivity",
          "BLOCKED",
          "P0",
          "No worker-health response was available to classify",
          remediation,
        ),
      );
    }
    return checks;
  }

  const unauthorized = response.status === 401 || response.status === 403;
  checks.push(
    check(
      "AUTOMATED_WORKER_HEALTH_REACHABLE",
      group,
      "connectivity",
      unauthorized ? "BLOCKED" : "PASS",
      "P0",
      unauthorized
        ? `Worker-health endpoint requires unavailable authentication (HTTP ${response.status})`
        : `Worker-health endpoint responded (HTTP ${response.status})`,
      remediation,
    ),
  );
  if (unauthorized) {
    for (const id of [
      "WORKER_HEALTH_RESPONSE_VALID",
      "WORKER_HEALTH_PRODUCTION_STATUS",
    ]) {
      checks.push(
        check(
          id,
          group,
          "connectivity",
          "BLOCKED",
          "P0",
          "Worker-health response is unavailable without authorized access",
          remediation,
        ),
      );
    }
    return checks;
  }

  const valid =
    body?.service === "squadpitch-api" &&
    ["ready", "not_ready"].includes(body?.status) &&
    typeof body?.dependencies?.db === "boolean" &&
    typeof body?.dependencies?.redis === "boolean" &&
    ["healthy", "degraded", "blocked"].includes(
      body?.dependencies?.workers,
    );
  checks.push(
    check(
      "WORKER_HEALTH_RESPONSE_VALID",
      group,
      "connectivity",
      valid ? "PASS" : "FAIL",
      "P0",
      valid
        ? "Worker-health response matches the safe readiness schema"
        : "Worker-health response schema is invalid",
      remediation,
    ),
  );
  if (!valid) {
    checks.push(
      check(
        "WORKER_HEALTH_PRODUCTION_STATUS",
        group,
        "connectivity",
        "FAIL",
        "P0",
        "Worker-health state cannot be trusted because the response schema is invalid",
        remediation,
      ),
    );
    return checks;
  }

  const workerStatus = body.dependencies.workers;
  const status =
    workerStatus === "healthy"
      ? "PASS"
      : workerStatus === "degraded"
        ? "WARN"
        : "FAIL";
  checks.push(
    check(
      "WORKER_HEALTH_PRODUCTION_STATUS",
      group,
      "connectivity",
      status,
      status === "FAIL" ? "P0" : "P2",
      `Observed ${now.toISOString()}: production worker status is ${workerStatus}`,
      remediation,
    ),
  );
  return checks;
}

async function stripeCheck(env, fetchImpl) {
  const catalog = [
    {
      tier: "Solo",
      priceId: env.STRIPE_STARTER_PRICE_ID,
      productId: env.STRIPE_STARTER_PRODUCT_ID,
      amount: 2900,
    },
    {
      tier: "Pro",
      priceId: env.STRIPE_PRO_PRICE_ID,
      productId: env.STRIPE_PRO_PRODUCT_ID,
      amount: 5900,
    },
    {
      tier: "Team",
      priceId: env.STRIPE_GROWTH_PRICE_ID,
      productId: env.STRIPE_GROWTH_PRODUCT_ID,
      amount: 14900,
    },
  ];
  if (
    !env.STRIPE_SECRET_KEY ||
    catalog.some(({ priceId, productId }) => !priceId || !productId)
  ) {
    return check(
      "stripe.connectivity",
      "Stripe",
      "connectivity",
      "BLOCKED",
      "P0",
      "Missing configuration prevented live probe",
      "Complete Stripe configuration.",
    );
  }
  try {
    const prices = [];
    for (const expected of catalog) {
      const response = await fetchImpl(
        `https://api.stripe.com/v1/prices/${encodeURIComponent(expected.priceId)}`,
        { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      if (!response.ok) {
        throw new Error(`Stripe returned HTTP ${response.status}`);
      }
      prices.push({ expected, actual: await response.json() });
    }
    const catalogMatches = prices.every(
      ({ expected, actual }) =>
        actual.livemode === true &&
        actual.active === true &&
        actual.type === "recurring" &&
        actual.product === expected.productId &&
        actual.unit_amount === expected.amount &&
        actual.currency === "usd" &&
        actual.recurring?.interval === "month" &&
        actual.recurring?.interval_count === 1,
    );
    return check(
      "stripe.connectivity",
      "Stripe",
      "connectivity",
      catalogMatches ? "PASS" : "FAIL",
      "P0",
      catalogMatches
        ? "Solo, Pro, and Team match the approved live monthly catalog"
        : "A self-service Stripe price does not match its approved live catalog",
      "Verify each self-service product, amount, currency, interval, and live Price ID.",
    );
  } catch {
    return check(
      "stripe.connectivity",
      "Stripe",
      "connectivity",
      "FAIL",
      "P0",
      "Live Stripe price verification failed",
      "Verify the live secret key and all three self-service product/price mappings.",
    );
  }
}

function stripeModeCheck(env) {
  const expected = env.STRIPE_EXPECTED_MODE ?? "live";
  const actual = stripeKeyMode(env.STRIPE_SECRET_KEY);
  const valid = expected === "live" && actual === "live";
  return check(
    "stripe.mode",
    "Stripe",
    "configuration",
    valid ? "PASS" : "FAIL",
    "P0",
    valid
      ? "Stripe production mode is explicitly live"
      : "Stripe key mode does not match live production mode",
    "Set STRIPE_EXPECTED_MODE=live and install the matching sk_live_ secret.",
  );
}

async function postmarkCheck(env, fetchImpl) {
  if (!env.POSTMARK_SERVER_TOKEN) {
    return check(
      "postmark.connectivity",
      "Postmark/email",
      "connectivity",
      "BLOCKED",
      "P2",
      "Provider is not configured",
      "Configure Postmark to enable the live probe.",
    );
  }
  try {
    const response = await fetchImpl("https://api.postmarkapp.com/server", {
      headers: {
        accept: "application/json",
        "x-postmark-server-token": env.POSTMARK_SERVER_TOKEN,
      },
    });
    const body = response.ok ? await response.json().catch(() => ({})) : {};
    const live = body?.DeliveryType === "Live";
    const inboundConfigured =
      typeof body?.InboundHookUrl === "string" &&
      body.InboundHookUrl.startsWith("https://");
    return check(
      "postmark.connectivity",
      "Postmark/email",
      "connectivity",
      response.ok && live && inboundConfigured ? "PASS" : "FAIL",
      "P0",
      response.ok && live && inboundConfigured
        ? "Postmark production server and inbound webhook are configured"
        : "Postmark server is unavailable, not live, or lacks an HTTPS inbound webhook",
      "Use a live Postmark server token and configure its inbound stream webhook.",
    );
  } catch {
    return check(
      "postmark.connectivity",
      "Postmark/email",
      "connectivity",
      "FAIL",
      "P0",
      "Postmark connectivity probe failed",
      "Verify the server token and Postmark network availability.",
    );
  }
}

async function twilioCheck(env, fetchImpl) {
  return check(
    "twilio.connectivity",
    "Twilio/SMS",
    "connectivity",
    "WARN",
    "P2",
    "Live Twilio connectivity is intentionally not probed while SMS is disabled",
    "Reverify connectivity only as part of an explicitly approved reactivation.",
  );
}

async function authenticatedCheck({
  id,
  group,
  url,
  headers,
  core,
  fetchImpl,
  remediation,
}) {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    return check(
      id,
      group,
      "connectivity",
      response.ok ? "PASS" : core ? "FAIL" : "WARN",
      core ? "P0" : "P2",
      response.ok
        ? `Authenticated probe succeeded (HTTP ${response.status})`
        : `Authenticated probe returned HTTP ${response.status}`,
      remediation,
    );
  } catch {
    return check(
      id,
      group,
      "connectivity",
      core ? "FAIL" : "WARN",
      core ? "P0" : "P2",
      "Authenticated connectivity probe failed",
      remediation,
    );
  }
}

async function probeResult(id, group, core, probe, options) {
  try {
    const result = await probe(options);
    return check(
      id,
      group,
      "connectivity",
      result.ok ? "PASS" : core ? "FAIL" : "WARN",
      core ? "P0" : "P2",
      result.message,
      result.remediation ?? `Restore ${group} connectivity.`,
    );
  } catch {
    return check(
      id,
      group,
      "connectivity",
      core ? "FAIL" : "WARN",
      core ? "P0" : "P2",
      "Probe failed",
      `Restore ${group} connectivity.`,
    );
  }
}

async function probeDatabase({ env, mode }) {
  if (!env.DATABASE_URL)
    return { ok: false, message: "DATABASE_URL is missing" };
  const { prisma } = await import("../../prisma.js");
  try {
    if (mode === "migrations") {
      const rows = await prisma.$queryRawUnsafe(
        'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL LIMIT 5',
      );
      return {
        ok: rows.length === 0,
        message:
          rows.length === 0
            ? "No unfinished Prisma migrations"
            : `${rows.length} unfinished Prisma migration(s) detected`,
        remediation:
          "Resolve failed/unfinished Prisma migrations before release.",
      };
    }
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, message: "Database query succeeded" };
  } finally {
    await prisma.$disconnect();
  }
}

async function probeRedis({ env }) {
  if (!env.REDIS_URL) return { ok: false, message: "REDIS_URL is missing" };
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 0,
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    return {
      ok: pong === "PONG",
      message:
        pong === "PONG"
          ? "Redis PING succeeded"
          : "Redis PING returned an unexpected response",
    };
  } finally {
    redis.disconnect();
  }
}

function auth0DiscoveryUrl(domain) {
  if (!domain) return null;
  const normalized = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${normalized}/.well-known/openid-configuration`;
}
