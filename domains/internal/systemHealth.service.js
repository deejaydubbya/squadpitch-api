// System Health aggregation service.
// Combines signals from DB, Redis, queues, providers, external services,
// webhooks, publishing, and notifications into a unified health view.

import { prisma, isConnected } from "../../prisma.js";
import { redisPing } from "../../redis.js";
import { env } from "../../config/env.js";
import { getAllServicesHealth, checkBudgetStatus, getThrottlePolicy } from "../billing/serviceHealth.service.js";
import { getQueueSummary } from "./jobs.service.js";
import { getWebhookSummary } from "./webhooks.service.js";
import { getServicesSummary } from "./externalServices.service.js";

// ── Health status helpers ───────────────────────────────────────────────

const startedAt = Date.now();

function worstStatus(...statuses) {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("unknown")) return "unknown";
  return "healthy";
}

// ── Core systems ────────────────────────────────────────────────────────

async function checkApi() {
  return {
    key: "api",
    name: "API Server",
    category: "core",
    status: "healthy",
    message: `Running ${env.NODE_ENV || "development"} — uptime ${Math.floor((Date.now() - startedAt) / 1000)}s`,
    impact: "All features",
    adminLink: null,
  };
}

async function checkDatabase() {
  try {
    const ok = await isConnected();
    return {
      key: "database",
      name: "PostgreSQL",
      category: "core",
      status: ok ? "healthy" : "down",
      message: ok ? "Connected" : "Connection failed",
      impact: "All features — total outage if down",
      adminLink: null,
    };
  } catch {
    return {
      key: "database",
      name: "PostgreSQL",
      category: "core",
      status: "down",
      message: "Health check threw an error",
      impact: "All features — total outage if down",
      adminLink: null,
    };
  }
}

async function checkRedis() {
  try {
    const ok = await redisPing();
    return {
      key: "redis",
      name: "Redis (Upstash)",
      category: "core",
      status: ok ? "healthy" : "down",
      message: ok ? "Connected" : "PING failed",
      impact: "Queues, caching, rate limiting, AI budget tracking",
      adminLink: "/admin/jobs",
    };
  } catch {
    return {
      key: "redis",
      name: "Redis (Upstash)",
      category: "core",
      status: "down",
      message: "PING threw an error",
      impact: "Queues, caching, rate limiting, AI budget tracking",
      adminLink: "/admin/jobs",
    };
  }
}

// ── AI Providers ────────────────────────────────────────────────────────

async function checkAiProviders() {
  const results = [];

  try {
    const health = await getAllServicesHealth();
    const [openaiBudget, falBudget] = await Promise.all([
      checkBudgetStatus("openai").catch(() => null),
      checkBudgetStatus("fal").catch(() => null),
    ]);

    // OpenAI
    let openaiMessage = health.openai === "healthy" ? "Operational" : `Status: ${health.openai}`;
    if (openaiBudget) {
      openaiMessage += ` — Budget: ${openaiBudget.percentage}% ($${(openaiBudget.spent / 100).toFixed(2)} / $${openaiBudget.limit === Infinity ? "unlimited" : (openaiBudget.limit / 100).toFixed(2)})`;
    }
    let openaiStatus = health.openai;
    if (openaiBudget?.status === "exceeded") openaiStatus = "down";
    else if (openaiBudget?.status === "warning" && openaiStatus === "healthy") openaiStatus = "degraded";

    results.push({
      key: "openai",
      name: "OpenAI",
      category: "ai",
      status: openaiStatus,
      message: openaiMessage,
      impact: "Content generation, campaigns, captions, AI parsing",
      adminLink: "/admin/external-services",
    });

    // Fal.ai
    let falMessage = health.fal === "healthy" ? "Operational" : `Status: ${health.fal}`;
    if (falBudget) {
      falMessage += ` — Budget: ${falBudget.percentage}% ($${(falBudget.spent / 100).toFixed(2)} / $${falBudget.limit === Infinity ? "unlimited" : (falBudget.limit / 100).toFixed(2)})`;
    }
    let falStatus = health.fal;
    if (falBudget?.status === "exceeded") falStatus = "down";
    else if (falBudget?.status === "warning" && falStatus === "healthy") falStatus = "degraded";

    results.push({
      key: "fal",
      name: "Fal.ai",
      category: "ai",
      status: falStatus,
      message: falMessage,
      impact: "Image generation, video generation",
      adminLink: "/admin/external-services",
    });
  } catch (err) {
    results.push({
      key: "ai-providers",
      name: "AI Providers",
      category: "ai",
      status: "unknown",
      message: `Health check failed: ${err.message}`,
      impact: "Content & media generation",
      adminLink: "/admin/external-services",
    });
  }

  return results;
}

// ── Queues ──────────────────────────────────────────────────────────────

async function checkQueues() {
  try {
    const summary = await getQueueSummary();
    const totalFailed = summary.reduce((s, q) => s + (q.counts?.failed || 0), 0);
    const totalActive = summary.reduce((s, q) => s + (q.counts?.active || 0), 0);
    const totalWaiting = summary.reduce((s, q) => s + (q.counts?.waiting || 0), 0);
    const hasErrors = summary.some((q) => q.error);

    let status = "healthy";
    if (hasErrors) status = "degraded";
    if (totalFailed > 50) status = "degraded";
    if (totalFailed > 200) status = "down";

    return {
      key: "queues",
      name: "Job Queues (BullMQ)",
      category: "core",
      status,
      message: `${summary.length} queues — ${totalActive} active, ${totalWaiting} waiting, ${totalFailed} failed`,
      impact: "Media gen, publishing, notifications, analytics, digests",
      adminLink: "/admin/jobs",
      detail: {
        queueCount: summary.length,
        totalActive,
        totalWaiting,
        totalFailed,
        queuesWithErrors: summary.filter((q) => q.error).map((q) => q.queue),
        failedByQueue: summary
          .filter((q) => (q.counts?.failed || 0) > 0)
          .map((q) => ({ queue: q.label, failed: q.counts.failed })),
      },
    };
  } catch (err) {
    return {
      key: "queues",
      name: "Job Queues (BullMQ)",
      category: "core",
      status: "unknown",
      message: `Queue check failed: ${err.message}`,
      impact: "Media gen, publishing, notifications, analytics, digests",
      adminLink: "/admin/jobs",
    };
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────

async function checkWebhooks() {
  try {
    const summary = await getWebhookSummary();

    let status = "healthy";
    if (summary.recentFailed24h > 10) status = "degraded";
    if (summary.activeEndpoints === 0 && summary.totalEndpoints > 0) status = "degraded";

    return {
      key: "webhooks",
      name: "Outbound Webhooks",
      category: "delivery",
      status,
      message: `${summary.activeEndpoints}/${summary.totalEndpoints} endpoints active — ${summary.recentFailed24h} failures (24h)`,
      impact: "Webhook integrations, automation triggers",
      adminLink: "/admin/webhooks",
    };
  } catch (err) {
    return {
      key: "webhooks",
      name: "Outbound Webhooks",
      category: "delivery",
      status: "unknown",
      message: `Check failed: ${err.message}`,
      impact: "Webhook integrations, automation triggers",
      adminLink: "/admin/webhooks",
    };
  }
}

// ── Publishing ──────────────────────────────────────────────────────────

async function checkPublishing() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [recentFailed, recentPublished, expiredConnections] = await Promise.all([
      prisma.draft.count({
        where: { status: "FAILED", updatedAt: { gte: since } },
      }),
      prisma.draft.count({
        where: { status: "PUBLISHED", publishedAt: { gte: since } },
      }),
      prisma.channelConnection.count({
        where: { status: "NEEDS_RECONNECT" },
      }),
    ]);

    let status = "healthy";
    let message = `${recentPublished} published, ${recentFailed} failed (24h)`;
    if (expiredConnections > 0) {
      message += ` — ${expiredConnections} connections need reconnect`;
    }
    if (recentFailed > 5 && recentPublished === 0) status = "down";
    else if (recentFailed > 0 || expiredConnections > 0) status = "degraded";

    return {
      key: "publishing",
      name: "Social Publishing",
      category: "delivery",
      status,
      message,
      impact: "Scheduled posts, social media delivery",
      adminLink: "/admin/publishing",
      detail: { recentPublished, recentFailed, expiredConnections },
    };
  } catch (err) {
    return {
      key: "publishing",
      name: "Social Publishing",
      category: "delivery",
      status: "unknown",
      message: `Check failed: ${err.message}`,
      impact: "Scheduled posts, social media delivery",
      adminLink: "/admin/publishing",
    };
  }
}

// ── Notifications ───────────────────────────────────────────────────────

async function checkNotifications() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [failedCount, sentCount] = await Promise.all([
      prisma.notificationLog.count({
        where: { status: "failed", createdAt: { gte: since } },
      }),
      prisma.notificationLog.count({
        where: { status: "sent", createdAt: { gte: since } },
      }),
    ]);

    let status = "healthy";
    if (failedCount > 10 && sentCount === 0) status = "down";
    else if (failedCount > 5) status = "degraded";

    return {
      key: "notifications",
      name: "Notifications",
      category: "delivery",
      status,
      message: `${sentCount} sent, ${failedCount} failed (24h)`,
      impact: "Email, SMS, push, Slack notifications",
      adminLink: "/admin/jobs",
    };
  } catch (err) {
    return {
      key: "notifications",
      name: "Notifications",
      category: "delivery",
      status: "unknown",
      message: `Check failed: ${err.message}`,
      impact: "Email, SMS, push, Slack notifications",
      adminLink: "/admin/jobs",
    };
  }
}

// ── External services ───────────────────────────────────────────────────

async function checkExternalServices() {
  try {
    const summary = await getServicesSummary();

    let status = "healthy";
    if (summary.critical > 0) status = "down";
    else if (summary.nearLimit > 0 || summary.watch > 0) status = "degraded";

    return {
      key: "external-services",
      name: "External Services",
      category: "vendor",
      status,
      message: `${summary.healthy}/${summary.total} healthy — ${summary.critical} critical, ${summary.nearLimit} near limit`,
      impact: "Auth, billing, email, media hosting, AI generation",
      adminLink: "/admin/external-services",
      detail: {
        total: summary.total,
        healthy: summary.healthy,
        watch: summary.watch,
        nearLimit: summary.nearLimit,
        critical: summary.critical,
        monthlyCost: `$${(summary.totalMonthlyCostCents / 100).toFixed(2)}`,
      },
    };
  } catch (err) {
    return {
      key: "external-services",
      name: "External Services",
      category: "vendor",
      status: "unknown",
      message: `Check failed: ${err.message}`,
      impact: "Auth, billing, email, media hosting, AI generation",
      adminLink: "/admin/external-services",
    };
  }
}

// ── Throttle / admin overrides ──────────────────────────────────────────

async function checkThrottle() {
  try {
    const policy = await getThrottlePolicy();

    const issues = [];
    if (policy.adminPaused) issues.push("AI generation paused by admin");
    if (policy.videoDisabled) issues.push("Video generation disabled");
    if (policy.textGenerationDisabled) issues.push("Text generation disabled");
    if (policy.regenerationsDisabled) issues.push("Regenerations disabled");

    let status = "healthy";
    if (policy.adminPaused || policy.textGenerationDisabled) status = "down";
    else if (policy.videoDisabled || policy.regenerationsDisabled) status = "degraded";

    return {
      key: "throttle",
      name: "AI Throttle Policy",
      category: "ai",
      status,
      message: issues.length > 0 ? issues.join("; ") : `Batch size: ${policy.maxBatchSize} — no restrictions`,
      impact: "Content generation throughput",
      adminLink: "/admin/external-services",
    };
  } catch {
    return {
      key: "throttle",
      name: "AI Throttle Policy",
      category: "ai",
      status: "unknown",
      message: "Could not determine throttle policy",
      impact: "Content generation throughput",
      adminLink: null,
    };
  }
}

// ── Auth ────────────────────────────────────────────────────────────────

function checkAuth() {
  const hasAuth0 = Boolean(env.AUTH0_DOMAIN && env.AUTH0_AUDIENCE);
  return {
    key: "auth",
    name: "Auth0",
    category: "core",
    status: hasAuth0 ? "healthy" : "degraded",
    message: hasAuth0 ? "Configured" : "Missing AUTH0_DOMAIN or AUTH0_AUDIENCE",
    impact: "User authentication, login, API access",
    adminLink: "/admin/external-services",
  };
}

// ── Main aggregation ────────────────────────────────────────────────────

export async function getSystemHealthSummary() {
  const checkedAt = new Date().toISOString();

  // Run all checks in parallel
  const [api, database, redis, aiProviders, queues, webhooks, publishing, notifications, extServices, throttle] = await Promise.all([
    checkApi(),
    checkDatabase(),
    checkRedis(),
    checkAiProviders(),
    checkQueues(),
    checkWebhooks(),
    checkPublishing(),
    checkNotifications(),
    checkExternalServices(),
    checkThrottle(),
  ]);

  const auth = checkAuth();

  // Flatten all services
  const services = [
    api,
    database,
    redis,
    auth,
    ...aiProviders,
    throttle,
    queues,
    publishing,
    webhooks,
    notifications,
    extServices,
  ];

  // Overall status
  const statuses = services.map((s) => s.status);
  const overall = worstStatus(...statuses);

  // Counts
  const counts = {
    healthy: statuses.filter((s) => s === "healthy").length,
    degraded: statuses.filter((s) => s === "degraded").length,
    down: statuses.filter((s) => s === "down").length,
    unknown: statuses.filter((s) => s === "unknown").length,
    total: statuses.length,
  };

  // Issues (non-healthy services)
  const issues = services
    .filter((s) => s.status !== "healthy")
    .map((s) => ({
      key: s.key,
      name: s.name,
      status: s.status,
      message: s.message,
      impact: s.impact,
      adminLink: s.adminLink,
    }));

  return {
    overall,
    counts,
    services,
    issues,
    checkedAt,
  };
}
