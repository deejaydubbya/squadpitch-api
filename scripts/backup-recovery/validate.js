#!/usr/bin/env node
import {
  backupRecoveryInventory,
  validateBackupRecoveryInventory,
} from "./inventory.js";
import evidence from "./evidence.json" with { type: "json" };
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const errors = validateBackupRecoveryInventory();
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const checks = [
  [
    "RUNBOOK_PRESENT",
    evidence.runbookPresent &&
      existsSync(
        path.join(repositoryRoot, "docs/production/backup-recovery.md"),
      ),
  ],
  ["PROVIDER_BACKUP_CONFIGURED", evidence.providerBackupConfigured],
  ["RECENT_BACKUP_CONFIRMED", evidence.recentBackupConfirmed],
  ["PITR_CONFIRMED", evidence.pitrConfirmed],
  ["RESTORE_TEST_COMPLETED", evidence.restoreTestCompleted],
  ["RESTORE_VALIDATION_PASSED", evidence.restoreValidationPassed],
].map(([id, passed]) => ({
  id,
  passed: Boolean(passed),
  status: passed ? "PASS" : "BLOCKED",
}));
const recoveryReady =
  errors.length === 0 && checks.every((check) => check.passed);
const report = {
  schemaVersion: "backup-recovery-verification.v2",
  generatedAt: new Date().toISOString(),
  safe: true,
  note: "Recorded provider evidence only; no provider, database, Redis, or storage mutation was attempted.",
  valid: errors.length === 0,
  recoveryReady,
  finalStatus: recoveryReady ? "PASS" : "BLOCKED",
  errors,
  evidence,
  checks,
  inventory: backupRecoveryInventory,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Backup/recovery verification: ${report.finalStatus}`);
  for (const check of checks) console.log(`${check.id}: ${check.status}`);
  console.log(`Evidence observed: ${evidence.observedAt}`);
  console.log(
    "A documentation-only pass does not establish recovery readiness.",
  );
}
if (errors.length) process.exitCode = 1;
