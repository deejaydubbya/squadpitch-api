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
        "STRIPE_AGENCY_PRICE_ID",
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
      ["worker.connectivity", "Redis/queues/workers"],
      ["api.connectivity", "Runtime/environment"],
      ["web.connectivity", "Runtime/environment"],
      ["sites.connectivity", "Sites runtime"],
      ["hosted-ai.connectivity", "Hosted AI + provenance"],
      ["hosted-ai.provenance", "Hosted AI + provenance"],
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
    env.SQUADPITCH_WORKER_HEALTH_URL
      ? await httpCheck({
          id: "worker.connectivity",
          group: "Redis/queues/workers",
          url: env.SQUADPITCH_WORKER_HEALTH_URL,
          core: true,
          fetchImpl,
          remediation:
            "Check the worker Fly machines, process health endpoint, Redis, and logs.",
        })
      : check(
          "worker.connectivity",
          "Redis/queues/workers",
          "connectivity",
          "BLOCKED",
          "P0",
          "SQUADPITCH_WORKER_HEALTH_URL is not configured for an automated worker probe",
          "Set a read-only worker health URL or verify Fly worker machines/logs manually.",
        ),
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
    await hostedAiProvenanceCheck(env, fetchImpl),
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
      : "Integration availability is capability-specific and approval-gated",
    "Downgrade unsupported or unapproved capabilities to BETA, COMING_SOON, or UNAVAILABLE.",
  );
}

async function hostedAiProvenanceCheck(env, fetchImpl) {
  const workspaceId = env.SQUADPITCH_VERIFY_WORKSPACE_ID;
  const baseUrl = env.SQUADPITCH_VERIFY_BASE_URL;
  const token = env.SQUADPITCH_VERIFY_TOKEN;
  const cookie = env.SQUADPITCH_VERIFY_COOKIE;
  if (!workspaceId || !baseUrl || (!token && !cookie)) {
    return check(
      "hosted-ai.provenance",
      "Hosted AI + provenance",
      "connectivity",
      "BLOCKED",
      "P0",
      "Authenticated AI verification configuration is unavailable",
      "Set SQUADPITCH_VERIFY_BASE_URL, WORKSPACE_ID, and token/cookie, then rerun.",
    );
  }
  try {
    const { verifyAiProduction } =
      await import("../ai-production-verification/runner.js");
    const report = await verifyAiProduction({
      baseUrl,
      token,
      cookie,
      workspaceId,
      fetchImpl,
    });
    const hosted = report.results.filter(
      (item) => item.status === "PASS" && item.source === "squadpitch-ai",
    ).length;
    return check(
      "hosted-ai.provenance",
      "Hosted AI + provenance",
      "connectivity",
      report.fail === 0 && hosted > 0 ? "PASS" : "FAIL",
      "P0",
      report.fail === 0
        ? `${hosted} hosted AI operation(s) verified with provenance`
        : `${report.fail} AI verification operation(s) failed`,
      "Run npm run verify:ai-production and repair signed private-network execution failures.",
    );
  } catch {
    return check(
      "hosted-ai.provenance",
      "Hosted AI + provenance",
      "connectivity",
      "FAIL",
      "P0",
      "Authenticated AI provenance verification failed",
      "Run npm run verify:ai-production and inspect API/Python trace logs.",
    );
  }
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
  const enabled = env.SMS_SENDING_ENABLED === "true";
  return configCheck({
    id: "twilio.config",
    group: "Twilio/SMS",
    variables: [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM_NUMBER",
      "TWILIO_MESSAGING_SERVICE_SID",
      "TWILIO_INBOUND_WEBHOOK_URL",
      "TWILIO_STATUS_CALLBACK_URL",
    ],
    required: enabled,
    remediation:
      "Configure Twilio credentials, E.164 sender, and signed webhook URLs, or keep SMS_SENDING_ENABLED=false.",
    env,
  });
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

async function stripeCheck(env, fetchImpl) {
  const priceIds = [
    env.STRIPE_STARTER_PRICE_ID,
    env.STRIPE_PRO_PRICE_ID,
    env.STRIPE_GROWTH_PRICE_ID,
    env.STRIPE_AGENCY_PRICE_ID,
  ].filter(Boolean);
  if (!env.STRIPE_SECRET_KEY || priceIds.length !== 4) {
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
    for (const priceId of priceIds) {
      const response = await fetchImpl(
        `https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`,
        { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      if (!response.ok) {
        throw new Error(`Stripe returned HTTP ${response.status}`);
      }
      prices.push(await response.json());
    }
    const allLiveRecurring = prices.every(
      (price) =>
        price.livemode === true && price.active && price.type === "recurring",
    );
    return check(
      "stripe.connectivity",
      "Stripe",
      "connectivity",
      allLiveRecurring ? "PASS" : "FAIL",
      "P0",
      allLiveRecurring
        ? "All four Stripe prices are active live recurring prices"
        : "A configured Stripe price is test-mode, inactive, or non-recurring",
      "Replace every tier price ID with its active live recurring Price object.",
    );
  } catch {
    return check(
      "stripe.connectivity",
      "Stripe",
      "connectivity",
      "FAIL",
      "P0",
      "Live Stripe price verification failed",
      "Verify the live secret key and all four production price IDs.",
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
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return check(
      "twilio.connectivity",
      "Twilio/SMS",
      "connectivity",
      "BLOCKED",
      "P2",
      "Provider is not configured",
      "Configure Twilio to enable the live probe.",
    );
  }
  const auth = Buffer.from(
    `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
  ).toString("base64");
  return authenticatedCheck({
    id: "twilio.connectivity",
    group: "Twilio/SMS",
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}.json`,
    headers: { authorization: `Basic ${auth}` },
    core: env.SMS_SENDING_ENABLED === "true",
    fetchImpl,
    remediation:
      "Verify the Twilio account SID/auth token and A2P registration.",
  });
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
