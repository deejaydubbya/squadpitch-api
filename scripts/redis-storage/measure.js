import Redis from "ioredis";
import { env } from "../../config/env.js";
import { classifyStorage, parseUsedMemory } from "./common.js";

const sampleSeconds = Math.max(
  0,
  Number(process.argv.find((arg) => arg.startsWith("--sample-seconds="))?.split("=")[1] || 0),
);
if (!env.REDIS_URL) throw new Error("REDIS_URL is required");

const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

async function sample() {
  const [info, keys] = await Promise.all([redis.info("memory"), redis.dbsize()]);
  return { observedAt: new Date().toISOString(), keys, ...classifyStorage(parseUsedMemory(info)) };
}

try {
  await redis.connect();
  const first = await sample();
  let result = { event: "redis.storage.measured", first };
  if (sampleSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, sampleSeconds * 1000));
    const second = await sample();
    result = {
      ...result,
      second,
      growthBytes:
        first.usedBytes === null || second.usedBytes === null
          ? null
          : second.usedBytes - first.usedBytes,
      growthBytesPerHour:
        first.usedBytes === null || second.usedBytes === null
          ? null
          : ((second.usedBytes - first.usedBytes) * 3600) / sampleSeconds,
      keyGrowth: second.keys - first.keys,
    };
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await redis.quit().catch(() => redis.disconnect());
}
