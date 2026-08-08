import Redis from "ioredis";
import { env } from "./config/env.js";

let redis = null;

export function assertRedisTestSafety({
  nodeEnv = env.NODE_ENV,
  redisUrl = env.REDIS_URL,
  allowExternal = env.ALLOW_EXTERNAL_REDIS_IN_TEST,
} = {}) {
  if (nodeEnv !== "test" || !redisUrl || allowExternal) return;
  const hostname = new URL(redisUrl).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(
      "External Redis is blocked in test mode; set ALLOW_EXTERNAL_REDIS_IN_TEST=true only for an intentional integration test",
    );
  }
}

export function getRedis() {
  if (redis) return redis;

  if (!env.REDIS_URL) {
    console.warn("[REDIS] No REDIS_URL configured — Redis features disabled");
    return null;
  }
  assertRedisTestSafety();

  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
  });

  redis.on("error", (err) => {
    console.error("[REDIS] Connection error:", err.message);
  });

  redis.on("connect", () => {
    console.log("[REDIS] Connected");
  });

  redis.connect().catch(() => {});

  return redis;
}

export async function redisGet(key) {
  try {
    const r = getRedis();
    if (!r) return null;
    return await r.get(key);
  } catch {
    return null;
  }
}

export async function redisSet(key, value, ttlSeconds) {
  try {
    const r = getRedis();
    if (!r) return false;
    if (ttlSeconds) {
      await r.set(key, value, "EX", ttlSeconds);
    } else {
      await r.set(key, value);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic set-if-not-exists with TTL. Returns true if the key was set, false if it already existed.
 */
export async function redisSetNX(key, value, ttlSeconds) {
  try {
    const r = getRedis();
    if (!r) return true; // fail-open: allow the request if Redis is down
    const result = await r.set(key, value, "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch {
    return true; // fail-open
  }
}

export async function redisDel(key) {
  try {
    const r = getRedis();
    if (!r) return false;
    await r.del(key);
    return true;
  } catch {
    return false;
  }
}

/** Delete a lease only when it is still owned by the supplied value. */
export async function redisCompareDelete(key, expectedValue) {
  try {
    const r = getRedis();
    if (!r) return false;
    const result = await r.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      expectedValue,
    );
    return result === 1;
  } catch {
    return false;
  }
}

/**
 * Create a NEW ioredis connection for BullMQ.
 * BullMQ requires separate connections for Queues vs Workers (Workers use
 * blocking commands). Each caller gets its own connection.
 */
export function getRedisConnection() {
  if (!env.REDIS_URL) {
    console.warn("[REDIS] No REDIS_URL configured — BullMQ connection unavailable");
    return null;
  }
  assertRedisTestSafety();

  const conn = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  conn.on("error", (err) => {
    console.error("[REDIS BULLMQ] Connection error:", err.message);
  });

  conn.on("connect", () => {
    console.log("[REDIS BULLMQ] Connected");
  });

  conn.connect().catch(() => {});

  return conn;
}

export async function redisPing() {
  try {
    const r = getRedis();
    if (!r) return false;
    const result = await r.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
