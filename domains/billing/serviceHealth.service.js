// Service Health + Budget Enforcement.
//
// Tracks provider health via failure counters (Redis + in-memory fallback)
// and enforces global monthly budget caps per AI provider.
// Fail-open everywhere: never blocks users due to infrastructure issues.

import { prisma } from "../../prisma.js";
import { redisGet, redisSet, redisDel, redisPing } from "../../redis.js";
import { env } from "../../config/env.js";

// ── Health tracking ─────────────────────────────────────────────────────────

const FAILURE_THRESHOLD_DEGRADED = 3;
const FAILURE_THRESHOLD_DOWN = 10;
const REDIS_HEALTH_CACHE_MS = 10_000;

// In-memory fallback counters (survive Redis outages).
const failureCounts = { openai: 0, fal: 0 };

let _redisHealthCache = { value: null, ts: 0 };

/**
 * Record a successful call to a service — resets failure counter.
 * @param {"openai"|"fal"} service
 */
export async function recordServiceSuccess(service) {
  failureCounts[service] = 0;
  try {
    await redisSet(`sp:health:failures:${service}`, "0");
  } catch { /* Redis down — in-memory is still accurate */ }
}

/**
 * Record a failed call to a service — increments failure counter.
 * @param {"openai"|"fal"} service
 */
export async function recordServiceFailure(service) {
  failureCounts[service] = (failureCounts[service] ?? 0) + 1;
  try {
    const key = `sp:health:failures:${service}`;
    const current = parseInt(await redisGet(key), 10) || 0;
    await redisSet(key, String(current + 1));
  } catch { /* Redis down — in-memory is still accurate */ }
}

/**
 * Get health status for a service.
 * @param {"openai"|"fal"|"redis"} service
 * @returns {Promise<"healthy"|"degraded"|"down">}
 */
export async function getServiceStatus(service) {
  if (service === "redis") {
    const now = Date.now();
    if (_redisHealthCache.value && now - _redisHealthCache.ts < REDIS_HEALTH_CACHE_MS) {
      return _redisHealthCache.value;
    }
    const ok = await redisPing();
    const status = ok ? "healthy" : "down";
    _redisHealthCache = { value: status, ts: now };
    return status;
  }

  // Try Redis first, fall back to in-memory.
  let count = failureCounts[service] ?? 0;
  try {
    const val = await redisGet(`sp:health:failures:${service}`);
    if (val != null) count = Math.max(count, parseInt(val, 10) || 0);
  } catch { /* use in-memory */ }

  if (count >= FAILURE_THRESHOLD_DOWN) return "down";
  if (count >= FAILURE_THRESHOLD_DEGRADED) return "degraded";
  return "healthy";
}

/**
 * Get health for all tracked services.
 * @returns {Promise<{ openai: string, fal: string, redis: string }>}
 */
export async function getAllServicesHealth() {
  const [openai, fal, redis] = await Promise.all([
    getServiceStatus("openai"),
    getServiceStatus("fal"),
    getServiceStatus("redis"),
  ]);
  return { openai, fal, redis };
}

// ── Throttle policy ─────────────────────────────────────────────────────────

const THROTTLE_CACHE_TTL = 30_000; // 30s in-memory
let _throttleCache = { value: null, ts: 0 };

/**
 * Get current throttle policy based on budget status and admin overrides.
 * Cached 30s in-memory. Fail-open: returns fully unrestricted on error.
 */
export async function getThrottlePolicy() {
  const now = Date.now();
  if (_throttleCache.value && now - _throttleCache.ts < THROTTLE_CACHE_TTL) {
    return _throttleCache.value;
  }

  try {
    const [falBudget, openaiBudget, adminPause, adminDisableVideo] = await Promise.all([
      checkBudgetStatus("fal").catch(() => ({ status: "ok" })),
      checkBudgetStatus("openai").catch(() => ({ status: "ok" })),
      redisGet("sp:admin:pause_ai").catch(() => null),
      redisGet("sp:admin:disable_video").catch(() => null),
    ]);

    const policy = {
      videoDisabled: adminDisableVideo === "1" || falBudget.status === "warning" || falBudget.status === "exceeded",
      maxBatchSize: falBudget.status === "exceeded" ? 1 : falBudget.status === "warning" ? 5 : 20,
      regenerationsDisabled: openaiBudget.status === "exceeded",
      textGenerationDisabled: openaiBudget.status === "exceeded",
      adminPaused: adminPause === "1",
    };

    _throttleCache = { value: policy, ts: now };
    return policy;
  } catch (err) {
    console.error("[SERVICE_HEALTH] Throttle policy failed:", err.message);
    // Fail-open: fully unrestricted
    return {
      videoDisabled: false,
      maxBatchSize: 20,
      regenerationsDisabled: false,
      textGenerationDisabled: false,
      adminPaused: false,
    };
  }
}

/**
 * Set an admin Redis flag.
 * @param {"sp:admin:pause_ai"|"sp:admin:disable_video"} key
 */
export async function setAdminFlag(key) {
  await redisSet(key, "1");
  // Invalidate throttle cache
  _throttleCache = { value: null, ts: 0 };
}

/**
 * Clear an admin Redis flag.
 * @param {"sp:admin:pause_ai"|"sp:admin:disable_video"} key
 */
export async function clearAdminFlag(key) {
  await redisDel(key);
  _throttleCache = { value: null, ts: 0 };
}

// ── Budget enforcement ──────────────────────────────────────────────────────

const BUDGET_CACHE_TTL = 60; // seconds

const PROVIDER_LIMITS = {
  openai: () => env.OPENAI_MONTHLY_BUDGET_CENTS,
  fal: () => env.FAL_MONTHLY_BUDGET_CENTS,
};

/**
 * Aggregate estimatedCostCents from AiUsageLog for a provider in a date range.
 * @param {"openai"|"fal"} provider
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<number>} total spend in cents
 */
export async function getProviderSpend(provider, from, to) {
  const modelFilter = provider === "openai"
    ? { startsWith: "gpt-" }
    : { startsWith: "fal-ai/" };

  const result = await prisma.aiUsageLog.aggregate({
    where: {
      model: modelFilter,
      createdAt: { gte: from, lt: to },
    },
    _sum: { estimatedCostCents: true },
  });

  return result._sum.estimatedCostCents ?? 0;
}

/**
 * Check budget status for a provider (current month).
 * @param {"openai"|"fal"} provider
 * @returns {Promise<{ spent: number, limit: number, percentage: number, status: "ok"|"warning"|"exceeded" }>}
 */
export async function checkBudgetStatus(provider) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const spent = await getProviderSpend(provider, from, to);
  const limit = PROVIDER_LIMITS[provider]?.() ?? Infinity;
  const percentage = limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0;

  let status = "ok";
  if (spent >= limit) {
    status = "exceeded";
  } else if (limit > 0 && spent / limit >= env.BUDGET_WARNING_THRESHOLD) {
    status = "warning";
  }

  return { spent, limit, percentage, status };
}

/**
 * Fast boolean check: is a provider over budget this month?
 * Cached 60s in Redis. Fail-open: returns false if Redis/DB unavailable.
 * @param {"openai"|"fal"} provider
 * @returns {Promise<boolean>}
 */
export async function isProviderBudgetExceeded(provider) {
  const cacheKey = `sp:budget:exceeded:${provider}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached != null) return cached === "1";
  } catch { /* fall through to DB */ }

  try {
    const { spent, limit } = await checkBudgetStatus(provider);
    const exceeded = spent >= limit;

    // Cache the result for 60s (fire-and-forget).
    redisSet(cacheKey, exceeded ? "1" : "0", BUDGET_CACHE_TTL).catch(() => {});

    return exceeded;
  } catch (err) {
    console.error(`[SERVICE_HEALTH] Budget check failed for ${provider}:`, err.message);
    // Fail-open: don't block users if we can't check.
    return false;
  }
}
