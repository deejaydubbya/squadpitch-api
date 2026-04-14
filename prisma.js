import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/**
 * Force-reconnect the Prisma connection pool.
 * Call this when queries fail with stale/dead connections (e.g. after Fly machine wake).
 */
export async function reconnectPrisma() {
  try {
    await prisma.$disconnect();
  } catch {
    // ignore disconnect errors
  }
  await prisma.$connect();
}
