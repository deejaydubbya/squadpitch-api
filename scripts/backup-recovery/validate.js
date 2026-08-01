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
const acceptedPitrWarning =
  !evidence.pitrConfirmed &&
  evidence.snapshotOnlyRecoveryAcceptedForControlledBeta === true;
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
  ["PITR_CONFIRMED", evidence.pitrConfirmed, acceptedPitrWarning],
  ["RESTORE_TEST_COMPLETED", evidence.restoreTestCompleted],
  ["RESTORE_VALIDATION_PASSED", evidence.restoreValidationPassed],
].map(([id, passed, acceptedWarning = false]) => ({
  id,
  passed: Boolean(passed),
  acceptedWarning,
  status: passed ? "PASS" : acceptedWarning ? "ACCEPTED_WARNING" : "BLOCKED",
}));
const recoveryReady =
  errors.length === 0 && checks.every((check) => check.passed);
const controlledBetaReady =
  errors.length === 0 &&
  checks.every((check) => check.passed || check.acceptedWarning);
const report = {
  schemaVersion: "backup-recovery-verification.v3",
  generatedAt: new Date().toISOString(),
  safe: true,
  note: "Recorded provider evidence only; no provider, database, Redis, or storage mutation was attempted.",
  valid: errors.length === 0,
  recoveryReady,
  controlledBetaReady,
  publicAcquisitionReady: recoveryReady,
  launchClassification: {
    controlledBeta: controlledBetaReady
      ? "ALLOWED_WITH_ACCEPTED_WARNING"
      : "BLOCKED",
    publicAcquisition: recoveryReady ? "ALLOWED" : "BLOCKED",
  },
  finalStatus: recoveryReady
    ? "PASS"
    : controlledBetaReady
      ? "WARN"
      : "BLOCKED",
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
  if (acceptedPitrWarning)
    console.log(`Accepted warning: ${evidence.acceptedWarning}`);
  console.log(
    "A documentation-only pass does not establish recovery readiness.",
  );
}
if (errors.length) process.exitCode = 1;
