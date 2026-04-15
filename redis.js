import Redis from "ioredis";
import { env } from "./config/env.js";

let redis = null;

export function getRedis() {
  if (redis) return redis;

  if (!env.REDIS_URL) {
    console.warn("[REDIS] No REDIS_URL configured — Redis features disabled");
    return null;
  }

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

let bullmqConnection = null;

export function getRedisConnection() {
  if (bullmqConnection) return bullmqConnection;

  if (!env.REDIS_URL) {
    console.warn("[REDIS] No REDIS_URL configured — BullMQ connection unavailable");
    return null;
  }

  bullmqConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  bullmqConnection.on("error", (err) => {
    console.error("[REDIS BULLMQ] Connection error:", err.message);
  });

  bullmqConnection.on("connect", () => {
    console.log("[REDIS BULLMQ] Connected");
  });

  bullmqConnection.connect().catch(() => {});

  return bullmqConnection;
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
