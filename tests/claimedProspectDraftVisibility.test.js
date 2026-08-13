import { beforeEach, describe, expect, it, vi } from "vitest";
import { customerVisibleWarnings, selectCanonicalProspectDrafts } from "../lib/prospectDraftVisibility.js";

const prismaMock = {
  prospectWorkspace: { findUnique: vi.fn() },
  draft: { findMany: vi.fn(), findUnique: vi.fn() },
};
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
const draftService = await import("../domains/studio/draft.service.js");

const draft = (id, channel, body, createdAt, status = "DRAFT") => ({ id, channel, body, createdAt: new Date(createdAt), status });

describe("claimed prospect Planner visibility", () => {
  beforeEach(() => vi.clearAllMocks());

  it("selects one newest accepted canonical draft per selected channel", () => {
    const items = [
      { itemType: "DRAFT", draftId: "ig-old", sortOrder: 1, draft: draft("ig-old", "INSTAGRAM", "old", "2026-01-01") },
      { itemType: "DRAFT", draftId: "ig-new", sortOrder: 2, draft: draft("ig-new", "INSTAGRAM", "accepted", "2026-02-01") },
      { itemType: "DRAFT", draftId: "fb-fallback", sortOrder: 3, draft: draft("fb-fallback", "FACEBOOK", "fallback", "2026-02-02") },
      { itemType: "DRAFT", draftId: "li-old", sortOrder: 4, draft: draft("li-old", "LINKEDIN", "old", "2026-01-01") },
      { itemType: "DRAFT", draftId: "li-new", sortOrder: 5, draft: draft("li-new", "LINKEDIN", "accepted", "2026-02-03") },
      { itemType: "DRAFT", draftId: "failed", sortOrder: 6, draft: draft("failed", "FACEBOOK", "PROSPECT_PROPERTY_FACT_GUARD:bad", "2026-02-04", "FAILED") },
      { itemType: "DRAFT", draftId: "removed", sortOrder: 7, draft: draft("removed", "X", "removed", "2026-02-05") },
    ];
    expect(selectCanonicalProspectDrafts(items, ["INSTAGRAM", "FACEBOOK", "LINKEDIN"]).map((item) => item.draftId)).toEqual(["ig-new", "fb-fallback", "li-new"]);
    expect(items).toHaveLength(7);
  });

  it("queries only canonical pre-claim rows plus ordinary post-claim customer drafts", async () => {
    const claimedAt = new Date("2026-03-01T00:00:00Z");
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({
      claimStatus: "CLAIMED", claimedAt, selectedChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
      previewItems: [
        { itemType: "DRAFT", draftId: "ig", sortOrder: 1, draft: draft("ig", "INSTAGRAM", "IG", "2026-02-01") },
        { itemType: "DRAFT", draftId: "fb", sortOrder: 2, draft: draft("fb", "FACEBOOK", "FB", "2026-02-01") },
        { itemType: "DRAFT", draftId: "li", sortOrder: 3, draft: draft("li", "LINKEDIN", "LI", "2026-02-01") },
      ],
    });
    prismaMock.draft.findMany.mockResolvedValue([]);
    await draftService.listDrafts({ clientId: "workspace", limit: 50 });
    expect(prismaMock.draft.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [
      { id: { in: ["ig", "fb", "li"] } },
      expect.objectContaining({ createdAt: { gt: claimedAt } }),
    ] }) }));
  });

  it("never projects internal diagnostics but keeps customer metadata", () => {
    expect(customerVisibleWarnings(["re_assets: listings=1 reviews=0", "PROSPECT_PROPERTY_FACT_GUARD:UNSUPPORTED_PROPERTY_CLAIM", "prospectProperty:item", "customer-safe"])).toEqual(["prospectProperty:item", "customer-safe"]);
    expect(draftService.formatDraft({ id: "d", warnings: ["re_assets: listings=1 reviews=0"], body: "Customer copy" })).not.toHaveProperty("sourceMeta.assets");
  });

  it("does not expose a rejected historical attempt by direct draft ID", async () => {
    const claimedAt = new Date("2026-03-01T00:00:00Z");
    prismaMock.draft.findUnique.mockResolvedValue({ id: "failed", clientId: "workspace", channel: "INSTAGRAM", status: "FAILED", body: "Internal attempt", createdAt: new Date("2026-02-01") });
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({ claimStatus: "CLAIMED", claimedAt, selectedChannels: ["INSTAGRAM"], previewItems: [
      { itemType: "DRAFT", draftId: "accepted", sortOrder: 1, draft: draft("accepted", "INSTAGRAM", "Accepted", "2026-02-02") },
    ] });
    await expect(draftService.getDraft("failed")).resolves.toBeNull();
  });

  it("does not change ordinary non-prospect workspace queries", async () => {
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue(null);
    prismaMock.draft.findMany.mockResolvedValue([]);
    await draftService.listDrafts({ clientId: "ordinary", limit: 50 });
    expect(prismaMock.draft.findMany.mock.calls[0][0].where).not.toHaveProperty("OR");
  });
});
