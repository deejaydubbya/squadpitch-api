// Idempotent feature-flag seeder.
//
// Inserts any flag from SEED_FLAGS (config.service.js) that doesn't
// already exist in the feature_flags table. Wired into the Fly
// release_command so new suite-foundation flags land
// automatically — re-running is cheap because seedFlags() only
// inserts on miss.

import { PrismaClient } from "@prisma/client";
import { seedFlags } from "../domains/internal/config.service.js";

const prisma = new PrismaClient();

async function main() {
  const startedAt = Date.now();
  console.log("[seedFlags] starting");
  const result = await seedFlags();
  const ms = Date.now() - startedAt;
  // seedFlags() returns the number it created — log both for
  // visibility on every deploy. On a steady state this is 0.
  if (typeof result === "object" && result !== null && "created" in result) {
    console.log(`[seedFlags] done in ${ms}ms — created=${result.created}`);
  } else if (typeof result === "number") {
    console.log(`[seedFlags] done in ${ms}ms — created=${result}`);
  } else {
    console.log(`[seedFlags] done in ${ms}ms`);
  }
}

main()
  .catch((err) => {
    console.error("[seedFlags] fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
