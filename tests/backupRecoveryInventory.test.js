import { describe, expect, it } from "vitest";
import {
  backupRecoveryInventory,
  validateBackupRecoveryInventory,
} from "../scripts/backup-recovery/inventory.js";
import { execFileSync } from "node:child_process";

describe("backup and recovery inventory", () => {
  it("covers every production persistence dependency", () => {
    expect(validateBackupRecoveryInventory()).toEqual([]);
    expect(backupRecoveryInventory.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "postgres",
        "cloudinary",
        "redis",
        "secrets-config",
        "stripe",
        "auth0",
        "ai-retrieval",
      ]),
    );
  });

  it("classifies Redis as mixed cache and durable runtime queue state", () => {
    expect(
      backupRecoveryInventory.find((item) => item.id === "redis"),
    ).toMatchObject({
      classification: "MIXED",
    });
  });

  it("rejects incomplete inventories", () => {
    expect(validateBackupRecoveryInventory([])).toContain(
      "Required recovery system missing: postgres",
    );
  });

  it("does not treat documentation and snapshots as full recovery readiness", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/backup-recovery/validate.js", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    const report = JSON.parse(output);
    expect(report.valid).toBe(true);
    expect(report.recoveryReady).toBe(false);
    expect(report.finalStatus).toBe("BLOCKED");
    expect(
      Object.fromEntries(report.checks.map(({ id, passed }) => [id, passed])),
    ).toMatchObject({
      RUNBOOK_PRESENT: true,
      PROVIDER_BACKUP_CONFIGURED: true,
      RECENT_BACKUP_CONFIRMED: true,
      PITR_CONFIRMED: false,
      RESTORE_TEST_COMPLETED: false,
      RESTORE_VALIDATION_PASSED: false,
    });
  });
});
