#!/usr/bin/env node
import {
  backupRecoveryInventory,
  validateBackupRecoveryInventory,
} from "./inventory.js";

const errors = validateBackupRecoveryInventory();
const report = {
  schemaVersion: "backup-recovery-metadata.v1",
  generatedAt: new Date().toISOString(),
  safe: true,
  note: "Static metadata validation only; no provider, database, Redis, or storage mutation was attempted.",
  valid: errors.length === 0,
  errors,
  inventory: backupRecoveryInventory,
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
