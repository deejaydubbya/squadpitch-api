import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = { prospectWorkspace: { findUnique: vi.fn() }, $transaction: vi.fn() };
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
const service = await import("../domains/prospects/prospect.service.js");

describe("explicit prospect preview selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty preview when nothing was explicitly selected", async () => {
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({ previewStatus: "ACTIVE", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), prospectName: "Jane", client: { lifecycle: "PROSPECT", name: "Realty", industryKey: "real_estate", logoUrl: null, brandProfile: null }, previewItems: [] });
    await expect(service.getPublicPreview(service.generateSecret())).resolves.toMatchObject({ items: [], drafts: [], preparationState: "NOT_STARTED" });
  });

  it("returns the exact stored body and all DraftAssets in their query order", async () => {
    const body = "🏡 Exact generated opener\n\n978 US Rt 52 · $425,000\n\n#GeorgetownOH #NewListing";
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({
      previewStatus: "ACTIVE", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), prospectName: "Erin",
      client: { lifecycle: "PROSPECT", name: "Erin Abbot", industryKey: "real_estate", logoUrl: null, brandProfile: null, _count: { dataItems: 1, drafts: 1 } },
      previewItems: [{ itemType: "DRAFT", draft: { status: "DRAFT", channel: "INSTAGRAM", body, mediaUrl: "https://cdn/one.jpg", draftAssets: [
        { orderIndex: 0, asset: { url: "https://cdn/one.jpg", thumbnailUrl: "https://cdn/one-thumb.jpg", assetType: "image", altText: "Front" } },
        { orderIndex: 1, asset: { url: "https://cdn/two.jpg", thumbnailUrl: null, assetType: "image", altText: "Kitchen" } },
        { orderIndex: 2, asset: { url: "https://cdn/three.jpg", thumbnailUrl: null, assetType: "image", altText: "Back" } },
      ] } }],
    });
    const preview = await service.getPublicPreview(service.generateSecret());
    expect(preview.drafts[0].body).toBe(body);
    expect(preview.drafts[0].media.map(({ url }) => url)).toEqual(["https://cdn/one.jpg", "https://cdn/two.jpg", "https://cdn/three.jpg"]);
    expect(preview.drafts[0].media.map(({ orderIndex }) => orderIndex)).toEqual([0, 1, 2]);
  });

  it("fails closed to the newest valid selected draft per platform", async () => {
    const draft = (id, body, createdAt) => ({ id, status: "DRAFT", channel: "FACEBOOK", body, createdAt, warnings: ["prospectProperty:item"], mediaUrl: "https://cdn/front.jpg", draftAssets: [{ orderIndex: 0, asset: { url: "https://cdn/front.jpg", thumbnailUrl: null, assetType: "image", altText: "Front" } }] });
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({ previewStatus: "ACTIVE", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), prospectName: "Jane", client: { lifecycle: "PROSPECT", name: "Realty", industryKey: "real_estate", logoUrl: null, brandProfile: null, _count: { dataItems: 1, drafts: 2 } }, previewItems: [
      { itemType: "DATA_ITEM", sortOrder: 0, dataItem: { status: "ACTIVE", type: "PROPERTY", title: "10 Main", summary: null, dataJson: { imageUrl: "https://cdn/front.jpg" } }, draft: null },
      { itemType: "DRAFT", sortOrder: 1, draft: draft("old", "Old Facebook", new Date("2026-01-01")) },
      { itemType: "DRAFT", sortOrder: 2, draft: draft("new", "New Facebook", new Date("2026-02-01")) },
    ] });
    const preview = await service.getPublicPreview(service.generateSecret());
    expect(preview.drafts).toHaveLength(1);
    expect(preview.drafts[0].body).toBe("New Facebook");
  });

  it("does not expose an incomplete property draft without DraftAssets when listing media exists", async () => {
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({ previewStatus: "ACTIVE", claimStatus: "CLAIMABLE", claimExpiresAt: new Date(Date.now() + 60_000), prospectName: "Jane", client: { lifecycle: "PROSPECT", name: "Realty", industryKey: "real_estate", logoUrl: null, brandProfile: null, _count: { dataItems: 1, drafts: 1 } }, previewItems: [
      { itemType: "DATA_ITEM", sortOrder: 0, dataItem: { status: "ACTIVE", type: "PROPERTY", title: "10 Main", summary: null, dataJson: { imageUrl: "https://cdn/front.jpg" } }, draft: null },
      { itemType: "DRAFT", sortOrder: 1, draft: { status: "DRAFT", channel: "FACEBOOK", body: "Incomplete", createdAt: new Date(), warnings: ["prospectProperty:item"], mediaUrl: null, draftAssets: [] } },
    ] });
    const preview = await service.getPublicPreview(service.generateSecret());
    expect(preview.drafts).toEqual([]);
  });

  it("rejects cross-workspace or ineligible records and leaves selection untouched", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ clientId: "client-a", client: { lifecycle: "PROSPECT" } }) }, workspaceDataItem: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) }, draft: { findMany: vi.fn().mockResolvedValue([]) }, prospectPreviewItem: { deleteMany: vi.fn(), createMany: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await expect(service.updatePreviewSelection("prospect-a", [{ itemType: "DATA_ITEM", id: "cm12345678901234567890123" }], "admin|1")).rejects.toMatchObject({ code: "INVALID_PREVIEW_SELECTION" });
    expect(tx.prospectPreviewItem.deleteMany).not.toHaveBeenCalled();
  });

  it("persists the exact operator order after tenant validation", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ clientId: "client-a", client: { lifecycle: "PROSPECT" } }) }, workspaceDataItem: { count: vi.fn().mockResolvedValue(1), findFirst: vi.fn().mockResolvedValue(null) }, draft: { findMany: vi.fn().mockResolvedValue([{ id: "draft-a", channel: "FACEBOOK", mediaUrl: null, _count: { draftAssets: 0 } }]) }, prospectPreviewItem: { deleteMany: vi.fn(), createMany: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    const items = [{ itemType: "DRAFT", id: "draft-a" }, { itemType: "DATA_ITEM", id: "item-a" }];
    await service.updatePreviewSelection("prospect-a", items, "admin|1");
    expect(tx.prospectPreviewItem.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ draftId: "draft-a", sortOrder: 0 }), expect.objectContaining({ dataItemId: "item-a", sortOrder: 1 })] });
  });

  it("rejects more than one selected draft for the same platform", async () => {
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ clientId: "client-a", client: { lifecycle: "PROSPECT" } }) }, workspaceDataItem: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) }, draft: { findMany: vi.fn().mockResolvedValue([{ id: "fb-old", channel: "FACEBOOK", _count: { draftAssets: 1 } }, { id: "fb-new", channel: "FACEBOOK", _count: { draftAssets: 1 } }]) }, prospectPreviewItem: { deleteMany: vi.fn(), createMany: vi.fn() } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await expect(service.updatePreviewSelection("prospect-a", [{ itemType: "DRAFT", id: "fb-old" }, { itemType: "DRAFT", id: "fb-new" }], "admin|1")).rejects.toMatchObject({ code: "DUPLICATE_PREVIEW_PLATFORM" });
    expect(tx.prospectPreviewItem.deleteMany).not.toHaveBeenCalled();
  });

  it("preserves explicit selection when claim and preview credentials rotate", async () => {
    const update = vi.fn().mockImplementation(({ data }) => ({ id: "prospect-a", clientId: "client-a", prospectName: "Jane", prospectEmail: "jane@example.com", claimStatus: "CLAIMABLE", previewStatus: "ACTIVE", claimIssuedAt: new Date(), claimExpiresAt: new Date(), createdAt: new Date(), client: { lifecycle: "PROSPECT", name: "Realty", industryKey: "real_estate" }, ...data }));
    const tx = { prospectWorkspace: { findUnique: vi.fn().mockResolvedValue({ id: "prospect-a", client: { lifecycle: "PROSPECT" } }), update } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    await service.rotateClaim("prospect-a");
    expect(update.mock.calls[0][0].data).not.toHaveProperty("previewItems");
  });
});
