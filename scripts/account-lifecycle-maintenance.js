#!/usr/bin/env node
import { runAccountLifecycleMaintenance } from "../domains/account/accountDeletionProviders.service.js";
import { prisma } from "../prisma.js";

try {
  const result = await runAccountLifecycleMaintenance();
  console.log(JSON.stringify({ event: "account_lifecycle.maintenance_completed", ...result }));
} catch (error) {
  console.error(JSON.stringify({ event: "account_lifecycle.maintenance_failed", code: error.code ?? "MAINTENANCE_FAILED" }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
