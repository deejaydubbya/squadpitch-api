import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  prospectWorkspace: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  client: { update: vi.fn() },
  contentPreferences: { upsert: vi.fn() },
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
      contentPreferences: { upsert: vi.fn() },
      agentOutreachProspect: { findUnique: vi.fn().mockResolvedValue({ id: "outreach1" }), update: vi.fn() },
    };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    const result = await service.claimWorkspace({ claimToken: service.generateSecret(), user: { id: "u1", email: "stale@example.com" }, auth0Sub: "auth0|jane", verifiedEmail: "JANE@example.com" });
    expect(result.clientId).toBe("c1");
    expect(tx.prospectWorkspace.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ claimStatus: "CLAIMED", claimTokenHash: null }) }));
    expect(tx.client.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { lifecycle: "CUSTOMER", status: "ACTIVE", createdBy: "auth0|jane" } });
    expect(tx.contentPreferences.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { preferredChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"] } }));
    expect(tx.agentOutreachProspect.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "outreach1" }, data: expect.objectContaining({ status: "CLAIMED", claimedAt: expect.any(Date) }) }));
  });

  it("discovers every active matching claim by normalized verified email", async () => {
    prismaMock.prospectWorkspace.findMany.mockResolvedValue([
      { id: "p1", clientId: "c1", selectedChannels: ["INSTAGRAM", "FACEBOOK"], claimExpiresAt: new Date(Date.now() + 60_000), client: { id: "c1", name: "Ready One", industryKey: "real_estate", _count: { drafts: 2, dataItems: 1 } } },
      { id: "p2", clientId: "c2", selectedChannels: ["INSTAGRAM"], claimExpiresAt: new Date(Date.now() + 60_000), client: { id: "c2", name: "Ready Two", industryKey: "real_estate", _count: { drafts: 1, dataItems: 1 } } },
    ]);
    const claims = await service.discoverPendingClaims(" User@Example.COM ");
    expect(claims.map(({ businessName }) => businessName)).toEqual(["Ready One", "Ready Two"]);
    expect(prismaMock.prospectWorkspace.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ prospectEmail: { equals: "user@example.com", mode: "insensitive" }, claimStatus: "CLAIMABLE" }) }));
    expect(prismaMock.prospectWorkspace.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: "desc" } }));
    expect(claims[0]).toMatchObject({ sourceType: "PREPARED_WORKSPACE", previewPath: "/invitations/p1/preview" });
  });

  it("authorizes invitation preview by matching verified email without exposing a token", async () => {
    prismaMock.prospectWorkspace.findFirst.mockResolvedValue({
      previewStatus: "ACTIVE", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), selectedChannels: ["INSTAGRAM"], prospectName: "Jane",
      client: { lifecycle: "PROSPECT", name: "Jane Realty", industryKey: "real_estate", logoUrl: null, brandProfile: null, _count: { drafts: 1, dataItems: 0 } }, previewItems: [],
    });
    const preview = await service.getInvitationPreview("p1", " Jane@Example.com ");
    expect(preview).toMatchObject({ businessName: "Jane Realty", claimAvailable: true });
    expect(prismaMock.prospectWorkspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "p1", prospectEmail: { equals: "jane@example.com", mode: "insensitive" }, claimStatus: "CLAIMABLE" }) }));
    expect(JSON.stringify(preview)).not.toContain("Token");
  });

  it("does not return another recipient's invitation preview", async () => {
    prismaMock.prospectWorkspace.findFirst.mockResolvedValue(null);
    await expect(service.getInvitationPreview("p1", "other@example.com")).resolves.toBeNull();
  });

  it("makes a repeated discovered claim idempotent for the same authenticated identity", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ id: "p1", clientId: "c1", claimStatus: "CLAIMED", claimedByUserId: "u1", claimedByAuth0Sub: "auth0|jane", client: { name: "Jane Realty", lifecycle: "CUSTOMER" } }) }, client: { update: vi.fn() }, contentPreferences: { upsert: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await expect(service.claimWorkspace({ prospectId: "p1", user: { id: "u1" }, auth0Sub: "auth0|jane", verifiedEmail: "jane@example.com" })).resolves.toMatchObject({ clientId: "c1", idempotent: true });
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it("fails safely when a concurrent claimant wins", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ id: "p1", clientId: "c1", prospectEmail: "jane@example.com", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), client: { lifecycle: "PROSPECT", name: "Jane Realty" } }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, client: { update: vi.fn() }, contentPreferences: { upsert: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await expect(service.claimWorkspace({ claimToken: service.generateSecret(), user: { id: "u1", email: "stale@example.com" }, auth0Sub: "auth0|jane", verifiedEmail: "jane@example.com" })).rejects.toMatchObject({ code: "CLAIM_RACE_LOST" });
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it("commits the EXPIRED state before returning an expiry error", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ id: "p1", clientId: "c1", prospectEmail: "jane@example.com", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() - 60_000), client: { lifecycle: "PROSPECT", name: "Jane Realty" } }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, client: { update: vi.fn() }, contentPreferences: { upsert: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await expect(service.claimWorkspace({ claimToken: service.generateSecret(), user: { id: "u1" }, auth0Sub: "auth0|jane", verifiedEmail: "jane@example.com" })).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    expect(tx.prospectWorkspace.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { claimStatus: "EXPIRED", claimTokenHash: null } }));
    expect(tx.client.update).not.toHaveBeenCalled();
  });
});
