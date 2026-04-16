import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  datasources: {
    db: {
      // Append pool tuning to the base DATABASE_URL:
      // - connection_limit=10: sized for performance-1x + 1GB Postgres
      // - pool_timeout=10: wait up to 10s for a pool slot instead of failing instantly
      // - connect_timeout=10: allow 10s for TCP connect (Fly internal DNS can be slow)
      // - socket_timeout=30: kill queries hanging longer than 30s (stale socket detection)
      url: appendParams(process.env.DATABASE_URL, {
        connection_limit: "10",
        pool_timeout: "10",
        connect_timeout: "10",
        socket_timeout: "30",
      }),
    },
  },
});

/**
 * Append query parameters to a database URL, merging with any existing params.
 */
function appendParams(url, params) {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  const extra = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${url}${sep}${extra}`;
}

// ── Reconnection with mutex ──────────────────────────────────────────────
//
// When the DB connection goes stale, many concurrent requests detect the
// failure simultaneously and all try to reconnect.  Without a mutex they
// trample each other ($disconnect mid-$connect), causing cascading errors.
// The mutex ensures only ONE reconnect cycle runs at a time; concurrent
// callers await the same in-flight promise.

let _reconnectPromise = null;

/**
 * Force-reconnect the Prisma connection pool.
 * Serialized: concurrent callers share one in-flight reconnect cycle.
 */
export async function reconnectPrisma() {
  if (_reconnectPromise) return _reconnectPromise;

  _reconnectPromise = _doReconnect().finally(() => {
    _reconnectPromise = null;
  });

  return _reconnectPromise;
}

async function _doReconnect() {
  try {
    await prisma.$disconnect();
  } catch {
    // ignore disconnect errors — pool may already be dead
  }

  // Retry connect — the Fly Postgres machine may need a few seconds
  for (let i = 0; i < 5; i++) {
    try {
      if (i > 0) await new Promise((r) => setTimeout(r, 1000 * Math.min(i, 3)));
      await prisma.$connect();
      console.log(`[prisma] Reconnected on attempt ${i + 1}`);
      return;
    } catch (err) {
      console.warn(`[prisma] Reconnect attempt ${i + 1}/5 failed: ${err.message}`);
      if (i === 4) throw err;
    }
  }
}

/**
 * Lightweight connection health check — SELECT 1.
 * Returns true if the pool has a live connection, false otherwise.
 */
export async function isConnected() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
