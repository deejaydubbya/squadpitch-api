import { describe, expect, it } from "vitest";
import {
  backupRecoveryInventory,
  validateBackupRecoveryInventory,
} from "../scripts/backup-recovery/inventory.js";

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
    expect(backupRecoveryInventory.find((item) => item.id === "redis")).toMatchObject({
      classification: "MIXED",
    });
  });

  it("rejects incomplete inventories", () => {
    expect(validateBackupRecoveryInventory([])).toContain(
      "Required recovery system missing: postgres",
    );
  });
});
