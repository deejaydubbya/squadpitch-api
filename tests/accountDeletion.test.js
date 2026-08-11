import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tokenCrypto.js", () => ({
  encryptToken: value => `encrypted:${value}`,
  decryptToken: value => {
    if (value === "invalid") throw Object.assign(new Error("Malformed encrypted target"), { code: "TOKEN_DECRYPT_MALFORMED" });
    return String(value).replace(/^encrypted:/, "");
  },
}));

import { cancelDeletion, purgeDeletion } from "../domains/account/accountLifecycle.service.js";
import { processProviderTask, runAccountLifecycleMaintenance } from "../domains/account/accountDeletionProviders.service.js";

const now = new Date("2026-08-20T00:00:00Z");
const user = { id: "user-a", auth0Sub: "auth0|owner-a" };

describe("account deletion state machine", () => {
  it("blocks final purge before the grace period elapses", async () => {
    const tx = { accountLifecycleRequest: { findUnique: vi.fn(async () => ({ id: "r", type: "DELETE_ACCOUNT", status: "GRACE_PERIOD", graceEndsAt: new Date("2026-08-21T00:00:00Z"), user })) } };
    const db = { $transaction: callback => callback(tx) };
    await expect(purgeDeletion({ requestId: "r", now, prismaClient: db })).rejects.toMatchObject({ code: "DELETION_GRACE_ACTIVE" });
  });

  it("cancellation restores only snapshotted workspaces still owned by the caller", async () => {
    const updates = [];
    const tx = {
      accountLifecycleRequest: {
        findFirst: vi.fn(async () => ({ id: "r", graceEndsAt: new Date("2026-08-21T00:00:00Z"), workspaceSnapshot: [{ id: "owned", status: "ACTIVE", siteStatus: "PUBLISHED", scheduledDraftIds: ["draft-a"] }] })),
        update: vi.fn(async ({ data }) => ({ id: "r", ...data })),
      },
      client: { updateMany: vi.fn(async args => { updates.push(args); return { count: 1 }; }) },
      site: { updateMany: vi.fn(async () => ({ count: 1 })) },
      draft: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const result = await cancelDeletion({ requestId: "r", user, now, prismaClient: { $transaction: callback => callback(tx) } });
    expect(updates[0].where).toEqual({ id: "owned", createdBy: user.auth0Sub, status: "ARCHIVED" });
    expect(result.status).toBe("CANCELLED");
    expect(tx.site.updateMany).toHaveBeenCalledWith({ where: { clientId: "owned", status: "ARCHIVED" }, data: { status: "PUBLISHED" } });
    expect(tx.draft.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["draft-a"] }, clientId: "owned", status: "FAILED" }, data: { status: "SCHEDULED", publishError: null } });
  });

  it("does not allow cancellation after grace expiry", async () => {
    const tx = { accountLifecycleRequest: { findFirst: vi.fn(async () => ({ id: "r", graceEndsAt: new Date("2026-08-19T00:00:00Z"), workspaceSnapshot: [] })) } };
    await expect(cancelDeletion({ requestId: "r", user, now, prismaClient: { $transaction: callback => callback(tx) } })).rejects.toMatchObject({ code: "DELETION_GRACE_ELAPSED" });
  });

  it("purges only workspaces selected by the exact owner and preserves billing", async () => {
    const deletes = [];
    const noopModel = { deleteMany: vi.fn(async args => { deletes.push(args); return { count: 0 }; }) };
    const tx = {
      accountLifecycleRequest: {
        findUnique: vi.fn(async () => ({ id: "r", userId: user.id, auth0Sub: user.auth0Sub, emailSnapshot: "owner@example.test", type: "DELETE_ACCOUNT", status: "GRACE_PERIOD", graceEndsAt: new Date("2026-08-19T00:00:00Z"), user })),
        update: vi.fn(async args => args.data),
      },
      client: { findMany: vi.fn(async () => [{ id: "owned" }]), deleteMany: vi.fn(async args => { deletes.push(args); return { count: 1 }; }) },
      mediaAsset: { findMany: vi.fn(async () => []) },
      accountDeletionProviderTask: { upsert: vi.fn(async args => args.create) },
      user: { update: vi.fn(async args => args.data) },
      usageRecord: noopModel, signupPlanIntent: noopModel, notificationPreference: noopModel,
      pushSubscription: noopModel, notificationLog: noopModel, notification: noopModel,
      activityEvent: noopModel, aiUsageLog: noopModel, integration: noopModel,
      slackConnection: noopModel, outboundWebhook: noopModel,
      subscription: { deleteMany: vi.fn() },
    };
    await purgeDeletion({ requestId: "r", now, prismaClient: { $transaction: callback => callback(tx) } });
    expect(tx.client.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["owned"] }, createdBy: user.auth0Sub } });
    expect(tx.subscription.deleteMany).not.toHaveBeenCalled();
    expect(tx.accountDeletionProviderTask.upsert).toHaveBeenCalledTimes(1);
    expect(tx.user.update.mock.invocationCallOrder[0]).toBeLessThan(tx.accountLifecycleRequest.update.mock.invocationCallOrder[0]);
  });
});

describe("provider cleanup", () => {
  it("uses the Auth0 tenant domain for the management token and delete calls", async () => {
    const previous = {
      domain: process.env.AUTH0_MANAGEMENT_DOMAIN,
      id: process.env.AUTH0_DELETION_CLIENT_ID,
      secret: process.env.AUTH0_DELETION_CLIENT_SECRET,
    };
    process.env.AUTH0_MANAGEMENT_DOMAIN = "tenant.us.auth0.com";
    process.env.AUTH0_DELETION_CLIENT_ID = "client-id";
    process.env.AUTH0_DELETION_CLIENT_SECRET = "client-secret";
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith("/oauth/token")) return { ok: true, json: async () => ({ access_token: "opaque-test-token" }) };
      return { ok: true, status: 204 };
    });
    const db = { accountDeletionProviderTask: { update: vi.fn(async args => args.data) } };
    try {
      const result = await processProviderTask({ id: "t", provider: "AUTH0", targetEncrypted: "encrypted:auth0|subject", status: "PENDING" }, { now, prismaClient: db, fetchImpl });
      expect(result.status).toBe("COMPLETED");
      expect(calls[0].url).toBe("https://tenant.us.auth0.com/oauth/token");
      expect(calls[0].body.audience).toBe("https://tenant.us.auth0.com/api/v2/");
      expect(calls[1].url).toBe("https://tenant.us.auth0.com/api/v2/users/auth0%7Csubject");
      expect(JSON.stringify(calls)).not.toContain("opaque-test-token");
    } finally {
      process.env.AUTH0_MANAGEMENT_DOMAIN = previous.domain;
      process.env.AUTH0_DELETION_CLIENT_ID = previous.id;
      process.env.AUTH0_DELETION_CLIENT_SECRET = previous.secret;
    }
  });

  it("records a sanitized retry code without exposing provider error text", async () => {
    const updates = [];
    const db = { accountDeletionProviderTask: { update: vi.fn(async args => { updates.push(args); return args.data; }) } };
    const task = { id: "t", provider: "AUTH0", targetEncrypted: "invalid", status: "PENDING" };
    const result = await processProviderTask(task, { now, prismaClient: db });
    expect(result.status).toBe("RETRY");
    expect(result.lastErrorCode).toBe("TOKEN_DECRYPT_MALFORMED");
    expect(JSON.stringify(updates)).not.toContain("invalid encrypted target content");
  });

  it("enforces export, AI-trace, audit, and tombstone retention cutoffs", async () => {
    const tx = { subscription: { deleteMany: vi.fn() }, accountLifecycleRequest: { delete: vi.fn() }, user: { deleteMany: vi.fn() } };
    const db = {
      accountLifecycleRequest: {
        findMany: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: "old-tombstone", userId: "deleted-user" }]),
        deleteMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(), updateMany: vi.fn(),
      },
      accountDeletionProviderTask: { findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]), count: vi.fn() },
      aiRunTrace: { deleteMany: vi.fn(async () => ({ count: 2 })) },
      auditLog: { deleteMany: vi.fn(async () => ({ count: 3 })) },
      $transaction: callback => callback(tx),
    };
    await runAccountLifecycleMaintenance({ now, prismaClient: db });
    expect(db.accountLifecycleRequest.deleteMany).toHaveBeenCalledWith({ where: { type: "EXPORT_ACCOUNT", exportExpiresAt: { lt: now } } });
    expect(db.aiRunTrace.deleteMany).toHaveBeenCalledWith({ where: { retentionUntil: { lt: now } } });
    expect(db.auditLog.deleteMany).toHaveBeenCalled();
    expect(tx.subscription.deleteMany).toHaveBeenCalledWith({ where: { userId: "deleted-user" } });
    expect(tx.user.deleteMany).toHaveBeenCalledWith({ where: { id: "deleted-user", auth0Sub: { startsWith: "deleted-" } } });
  });
});
