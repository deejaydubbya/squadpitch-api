import { env, bootEnvWarnings } from "./config/env.js";
import { assertProductionConfig } from "./config/productionConfig.js";
import { initSentry } from "./lib/sentry.js";
import { getRedis } from "./redis.js";
import { startWorkers, stopWorkers } from "./workers/index.js";
import { prisma } from "./prisma.js";

process.env.PROCESS_ROLE ||= "worker";
assertProductionConfig(env);
bootEnvWarnings();
initSentry();

await prisma.$connect();
await startWorkers();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "worker.shutdown", signal }));
  await stopWorkers();
  await prisma.$disconnect();
  const redis = getRedis();
  if (redis) await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
