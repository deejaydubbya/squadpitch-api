import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/**
 * Force-reconnect the Prisma connection pool.
 * Call this when queries fail with stale/dead connections (e.g. after Fly machine wake).
 * Retries $connect internally since the DB may still be waking.
 */
export async function reconnectPrisma() {
  try {
    await prisma.$disconnect();
  } catch {
    // ignore disconnect errors
  }

  // Retry connect — the Fly Postgres machine may need a few seconds to wake
  for (let i = 0; i < 3; i++) {
    try {
      await prisma.$connect();
      return;
    } catch (err) {
      if (i < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      } else {
        throw err;
      }
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
