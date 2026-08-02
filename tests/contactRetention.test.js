import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyContacts = vi.fn();
const deleteContacts = vi.fn();
const deleteSubmissions = vi.fn();
const createAudit = vi.fn();
const findWorkspaces = vi.fn();
const tx = {
  contact: { deleteMany: deleteContacts },
  formSubmission: { deleteMany: deleteSubmissions },
  auditLog: { create: createAudit },
};

vi.mock("../prisma.js", () => ({
  prisma: {
    contact: { findMany: findManyContacts },
    client: { findMany: findWorkspaces },
    $transaction: vi.fn(async (callback) => callback(tx)),
  },
}));

const { enforceWorkspaceContactRetention, retentionCutoff, runContactRetention } =
  await import("../domains/inbox/contactRetention.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  findManyContacts.mockResolvedValue([]);
  findWorkspaces.mockResolvedValue([]);
  deleteContacts.mockResolvedValue({ count: 0 });
  deleteSubmissions.mockResolvedValue({ count: 0 });
  createAudit.mockResolvedValue({});
});

describe("contact retention", () => {
  it("uses one exact UTC cutoff and disables null, zero, and negative values", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(retentionCutoff(now, 30)?.toISOString()).toBe("2026-07-02T12:00:00.000Z");
    expect(retentionCutoff(now, null)).toBeNull();
    expect(retentionCutoff(now, 0)).toBeNull();
    expect(retentionCutoff(now, -1)).toBeNull();
  });

  it("selects only stale contacts without a fresh conversation", async () => {
    await enforceWorkspaceContactRetention({
      clientId: "workspace-a",
      retentionDays: 30,
      now: new Date("2026-08-01T12:00:00Z"),
      dryRun: true,
    });
    expect(findManyContacts).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        clientId: "workspace-a",
        updatedAt: { lt: new Date("2026-07-02T12:00:00Z") },
        conversations: { none: { updatedAt: { gte: new Date("2026-07-02T12:00:00Z") } } },
      },
      take: 100,
    }));
    expect(deleteContacts).not.toHaveBeenCalled();
  });

  it("deletes only tenant-scoped candidates and linked submissions", async () => {
    findManyContacts.mockResolvedValue([{ id: "contact-a", conversations: [{ sourceFormSubmissionId: "submission-a" }] }]);
    const result = await enforceWorkspaceContactRetention({
      clientId: "workspace-a",
      retentionDays: 30,
      now: new Date("2026-08-01T12:00:00Z"),
    });
    expect(deleteContacts).toHaveBeenCalledWith({ where: { clientId: "workspace-a", id: { in: ["contact-a"] } } });
    expect(deleteSubmissions).toHaveBeenCalledWith({ where: { clientId: "workspace-a", id: { in: ["submission-a"] } } });
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "inbox.contact.retention_purge",
        metadata: expect.not.objectContaining({ body: expect.anything() }),
      }),
    }));
    expect(result.deleted).toBe(1);
  });

  it("processes only active workspaces with positive configured retention", async () => {
    await runContactRetention({ dryRun: true });
    expect(findWorkspaces).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "ACTIVE", contactRetentionDays: { gt: 0 } },
    }));
  });
});
