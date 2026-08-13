import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  prospectWorkspace: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  client: { update: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));

const service = await import("../domains/prospects/prospect.service.js");

describe("prospect workspace security", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates 256-bit URL-safe secrets and irreversible fixed-size digests", () => {
    const first = service.generateSecret();
    const second = service.generateSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(service.digestSecret(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(service.digestSecret(first)).not.toContain(first);
  });

  it("returns a strict allowlisted preview without prospect email or internal metadata", async () => {
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({
      previewStatus: "ACTIVE", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000),
      prospectName: "Jane", prospectEmail: "private@example.com", operatorNote: "secret note",
      client: { lifecycle: "PROSPECT", name: "Jane Realty", industryKey: "real_estate", logoUrl: null,
        brandProfile: { description: "Homes", website: "https://example.com", city: "Austin", state: "TX", socialsJson: { token: "secret" } },
      },
      previewItems: [
        { itemType: "DATA_ITEM", dataItem: { id: "item", status: "ACTIVE", type: "PROPERTY", title: "123 Main", summary: "Listing", dataJson: { imageUrl: "https://img.example/a.jpg", private: "no" } }, draft: null },
        { itemType: "DRAFT", dataItem: null, draft: { id: "draft", status: "DRAFT", channel: "FACEBOOK", body: "Sample", mediaUrl: null, mediaAssets: [] } },
      ],
    });
    const preview = await service.getPublicPreview(service.generateSecret());
    expect(preview.businessName).toBe("Jane Realty");
    expect(JSON.stringify(preview)).not.toContain("private@example.com");
    expect(JSON.stringify(preview)).not.toContain("secret note");
    expect(JSON.stringify(preview)).not.toContain('"private"');
    expect(JSON.stringify(preview)).not.toContain('"token"');
  });

  it("requires verified invited email before entering the claim transaction", async () => {
    await expect(service.claimWorkspace({ claimToken: service.generateSecret(), user: { id: "u", email: "jane@example.com" }, auth0Sub: "auth0|jane", verifiedEmail: false })).rejects.toMatchObject({ code: "VERIFIED_EMAIL_REQUIRED" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [null, "missing token"],
    [{ claimStatus: "REVOKED", claimExpiresAt: new Date(Date.now() + 60_000), client: { lifecycle: "PROSPECT" } }, "revoked token"],
    [{ claimStatus: "CLAIMED", claimExpiresAt: new Date(Date.now() + 60_000), client: { lifecycle: "CUSTOMER" } }, "used token"],
    [{ claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() - 60_000), client: { lifecycle: "PROSPECT" } }, "expired token"],
  ])("does not validate %s (%s)", async (row) => {
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue(row);
    await expect(service.inspectClaim(service.generateSecret())).resolves.toEqual({ valid: false });
  });

  it("claims with one conditional update and atomically transfers the existing client", async () => {
    const tx = {
      prospectWorkspace: {
        findUnique: vi.fn().mockResolvedValue({ id: "p1", clientId: "c1", prospectEmail: "jane@example.com", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), client: { lifecycle: "PROSPECT", name: "Jane Realty" } }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      client: { update: vi.fn().mockResolvedValue({ id: "c1" }) },
    };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    const result = await service.claimWorkspace({ claimToken: service.generateSecret(), user: { id: "u1", email: "stale@example.com" }, auth0Sub: "auth0|jane", verifiedEmail: "JANE@example.com" });
    expect(result.clientId).toBe("c1");
    expect(tx.prospectWorkspace.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ claimStatus: "CLAIMED", claimTokenHash: null }) }));
    expect(tx.client.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { lifecycle: "CUSTOMER", status: "ACTIVE", createdBy: "auth0|jane" } });
  });

  it("fails safely when a concurrent claimant wins", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ id: "p1", clientId: "c1", prospectEmail: "jane@example.com", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), client: { lifecycle: "PROSPECT", name: "Jane Realty" } }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, client: { update: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await expect(service.claimWorkspace({ claimToken: service.generateSecret(), user: { id: "u1", email: "stale@example.com" }, auth0Sub: "auth0|jane", verifiedEmail: "jane@example.com" })).rejects.toMatchObject({ code: "CLAIM_RACE_LOST" });
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it("commits the EXPIRED state before returning an expiry error", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ id: "p1", clientId: "c1", prospectEmail: "jane@example.com", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() - 60_000), client: { lifecycle: "PROSPECT", name: "Jane Realty" } }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, client: { update: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await expect(service.claimWorkspace({ claimToken: service.generateSecret(), user: { id: "u1" }, auth0Sub: "auth0|jane", verifiedEmail: "jane@example.com" })).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    expect(tx.prospectWorkspace.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { claimStatus: "EXPIRED", claimTokenHash: null } }));
    expect(tx.client.update).not.toHaveBeenCalled();
  });
});
