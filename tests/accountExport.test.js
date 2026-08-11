import { describe, expect, it, vi } from "vitest";
import { collectAccountExport, createExportArchive, prepareExportDownload, sanitizeExport } from "../domains/account/accountExport.service.js";

const user = { id: "user-a", auth0Sub: "auth0|owner-a", email: "owner@example.test", name: "Owner", avatarUrl: null, role: "OWNER", createdAt: new Date(), updatedAt: new Date() };

function exportPrisma() {
  return {
    client: { findMany: vi.fn(async args => [{ id: "workspace-a", createdBy: "auth0|owner-a", connections: [{ id: "c", accessToken: "must-not-export", refreshToken: "must-not-export", displayName: "Provider" }] }]) },
    subscription: { findUnique: vi.fn(async () => ({ tier: "STARTER", status: "ACTIVE", stripeCustomerId: "must-not-export", paymentMethod: "must-not-export" })) },
    usageRecord: { findMany: vi.fn(async () => []) }, activityEvent: { findMany: vi.fn(async () => []) },
    integration: { findMany: vi.fn(async () => [{ id: "i", name: "Safe metadata", config: { secret: "must-not-export" } }]) },
    aiUsageLog: { findMany: vi.fn(async () => []) }, auditLog: { findMany: vi.fn(async () => []) },
  };
}

describe("account export", () => {
  it("queries workspaces by the authenticated owner's subject and strips secrets", async () => {
    const db = exportPrisma();
    const data = await collectAccountExport({ user, prismaClient: db });
    expect(db.client.findMany.mock.calls[0][0].where).toEqual({ createdBy: user.auth0Sub });
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/accessToken|refreshToken|paymentMethod/);
    expect(data.billing.stripeCustomerId).toBe("must-not-export");
    expect(data.account.email).toBe(user.email);
    expect(data.workspaces[0].id).toBe("workspace-a");
  });

  it("recursively excludes secret-bearing keys", () => {
    expect(sanitizeExport({ safe: 1, config: { apiSecret: "x", nested: [{ refreshToken: "y", label: "ok" }] } })).toEqual({ safe: 1, config: { nested: [{ label: "ok" }] } });
  });

  it("creates a versioned zip and integrity manifest", async () => {
    const result = await createExportArchive({ user, generatedAt: new Date("2026-08-11T00:00:00Z"), prismaClient: exportPrisma() });
    expect(result.buffer.subarray(0, 2).toString()).toBe("PK");
    expect(result.manifest.schemaVersion).toBe("squadpitch-account-export.v1");
    expect(result.manifest.expiresAt).toBe("2026-08-18T00:00:00.000Z");
    expect(result.manifest.sections.every(section => /^[a-f0-9]{64}$/.test(section.sha256))).toBe(true);
  });

  it("blocks cross-user request IDs and expired downloads", async () => {
    const db = exportPrisma();
    db.accountLifecycleRequest = { findFirst: vi.fn(async () => null) };
    await expect(prepareExportDownload({ requestId: "other", user, prismaClient: db })).rejects.toMatchObject({ code: "EXPORT_NOT_FOUND" });
    db.accountLifecycleRequest.findFirst.mockResolvedValue({ id: "mine", userId: user.id, type: "EXPORT_ACCOUNT", exportExpiresAt: new Date("2026-08-10T00:00:00Z") });
    await expect(prepareExportDownload({ requestId: "mine", user, now: new Date("2026-08-11T00:00:00Z"), prismaClient: db })).rejects.toMatchObject({ code: "EXPORT_EXPIRED" });
  });

  it("retries generation idempotently for the same owned request", async () => {
    const db = exportPrisma();
    db.accountLifecycleRequest = { findFirst: vi.fn(async () => ({ id: "mine", userId: user.id, type: "EXPORT_ACCOUNT", exportExpiresAt: null })), update: vi.fn(async args => args.data) };
    const first = await prepareExportDownload({ requestId: "mine", user, now: new Date("2026-08-11T00:00:00Z"), prismaClient: db });
    const second = await prepareExportDownload({ requestId: "mine", user, now: new Date("2026-08-11T00:01:00Z"), prismaClient: db });
    expect(first.buffer.length).toBeGreaterThan(0);
    expect(second.buffer.length).toBeGreaterThan(0);
    expect(db.accountLifecycleRequest.update).toHaveBeenCalledTimes(2);
  });
});
