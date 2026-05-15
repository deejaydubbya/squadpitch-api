// Tenant-isolation regression for the business-data item routes.
//
// Background: a final-QA audit found that the legacy
// /api/v1/business-data/:itemId routes (GET/PATCH/POST archive/
// DELETE/opportunities) had no workspace ownership check and the
// service layer used findUnique({ where: { id } }) with no
// clientId scope. Any authenticated user could read or mutate any
// other workspace's data items by guessing cuid ids.
//
// The fix moved every route under /workspaces/:id/business-data/
// with requireClientOwner and rewrote the service methods to
// require clientId + use findFirst/updateMany/deleteMany filtered
// by (id, clientId).
//
// These tests assert that workspace A's caller cannot affect
// workspace B's item even when the item id is correct.

import { describe, it, expect, vi, beforeEach } from "vitest";

let state;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return state.prisma;
  },
}));

const dataService = await import("../domains/studio/data.service.js");
const opportunityService = await import(
  "../domains/studio/contentOpportunity.service.js"
);

function buildPrismaMock(items, blueprints = []) {
  const itemsMap = new Map(items.map((i) => [i.id, i]));
  return {
    workspaceDataItem: {
      findFirst: vi.fn(async ({ where }) => {
        for (const it of itemsMap.values()) {
          if (it.id !== where.id) continue;
          if (where.clientId && it.clientId !== where.clientId) continue;
          return it;
        }
        return null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const it of itemsMap.values()) {
          if (it.id !== where.id) continue;
          if (where.clientId && it.clientId !== where.clientId) continue;
          itemsMap.set(it.id, { ...it, ...data });
          count++;
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }) => {
        let count = 0;
        for (const [id, it] of itemsMap.entries()) {
          if (it.id !== where.id) continue;
          if (where.clientId && it.clientId !== where.clientId) continue;
          itemsMap.delete(id);
          count++;
        }
        return { count };
      }),
    },
    contentBlueprint: {
      findMany: vi.fn(async () => blueprints),
    },
    dataItemPerformance: {
      findUnique: vi.fn(async () => null),
    },
  };
}

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const ITEM_B = {
  id: "item-b",
  clientId: CLIENT_B,
  type: "PROPERTY",
  title: "Client B's secret listing",
  status: "ACTIVE",
};
const ITEM_A = {
  id: "item-a",
  clientId: CLIENT_A,
  type: "PROPERTY",
  title: "Client A's listing",
  status: "ACTIVE",
};

describe("business-data tenant isolation — cross-workspace must fail", () => {
  beforeEach(() => {
    state = { prisma: buildPrismaMock([ITEM_A, ITEM_B]) };
  });

  it("getDataItem(client A, item B's id) returns null", async () => {
    const result = await dataService.getDataItem(CLIENT_A, ITEM_B.id);
    expect(result).toBeNull();
  });

  it("updateDataItem(client A, item B's id, patch) returns null and does not mutate", async () => {
    const result = await dataService.updateDataItem(CLIENT_A, ITEM_B.id, {
      title: "PWNED",
    });
    expect(result).toBeNull();
    // Confirm B's title is still intact.
    const fresh = await dataService.getDataItem(CLIENT_B, ITEM_B.id);
    expect(fresh.title).toBe("Client B's secret listing");
  });

  it("archiveDataItem(client A, item B's id) returns null and does not flip status", async () => {
    const result = await dataService.archiveDataItem(CLIENT_A, ITEM_B.id);
    expect(result).toBeNull();
    const fresh = await dataService.getDataItem(CLIENT_B, ITEM_B.id);
    expect(fresh.status).toBe("ACTIVE");
  });

  it("deleteDataItem(client A, item B's id) returns false and item still exists", async () => {
    const ok = await dataService.deleteDataItem(CLIENT_A, ITEM_B.id);
    expect(ok).toBe(false);
    // B can still read it.
    const fresh = await dataService.getDataItem(CLIENT_B, ITEM_B.id);
    expect(fresh).not.toBeNull();
    expect(fresh.id).toBe(ITEM_B.id);
  });

  it("getOpportunitiesForItem(client A, item B's id) returns [] (does not leak item type)", async () => {
    const result = await opportunityService.getOpportunitiesForItem(
      CLIENT_A,
      ITEM_B.id,
    );
    expect(result).toEqual([]);
  });
});

describe("business-data tenant isolation — rightful owner still works", () => {
  beforeEach(() => {
    state = {
      prisma: buildPrismaMock([ITEM_A, ITEM_B], [
        {
          id: "bp-1",
          slug: "property-listing",
          name: "Property Listing",
          category: "LISTING",
          description: "blue print",
          isActive: true,
          applicableTypes: ["PROPERTY"],
          applicableChannels: [],
        },
      ]),
    };
  });

  it("getDataItem(rightful owner) returns the item", async () => {
    const result = await dataService.getDataItem(CLIENT_B, ITEM_B.id);
    expect(result).not.toBeNull();
    expect(result.id).toBe(ITEM_B.id);
  });

  it("updateDataItem(rightful owner) applies the patch", async () => {
    const result = await dataService.updateDataItem(CLIENT_B, ITEM_B.id, {
      title: "Renamed by owner",
    });
    expect(result).not.toBeNull();
    expect(result.title).toBe("Renamed by owner");
  });

  it("archiveDataItem(rightful owner) flips status to ARCHIVED", async () => {
    const result = await dataService.archiveDataItem(CLIENT_B, ITEM_B.id);
    expect(result).not.toBeNull();
    expect(result.status).toBe("ARCHIVED");
  });

  it("deleteDataItem(rightful owner) succeeds and removes the row", async () => {
    const ok = await dataService.deleteDataItem(CLIENT_B, ITEM_B.id);
    expect(ok).toBe(true);
    const fresh = await dataService.getDataItem(CLIENT_B, ITEM_B.id);
    expect(fresh).toBeNull();
  });

  it("getOpportunitiesForItem(rightful owner) returns scored blueprints", async () => {
    const result = await opportunityService.getOpportunitiesForItem(
      CLIENT_B,
      ITEM_B.id,
    );
    expect(result.length).toBe(1);
    expect(result[0].blueprint.slug).toBe("property-listing");
  });
});

describe("service method guards — missing clientId throws", () => {
  beforeEach(() => {
    state = { prisma: buildPrismaMock([ITEM_A]) };
  });

  it("getDataItem throws when clientId is falsy", async () => {
    await expect(dataService.getDataItem(null, ITEM_A.id)).rejects.toThrow(
      /requires clientId/,
    );
  });

  it("updateDataItem throws when clientId is falsy", async () => {
    await expect(
      dataService.updateDataItem(null, ITEM_A.id, { title: "x" }),
    ).rejects.toThrow(/requires clientId/);
  });

  it("archiveDataItem throws when clientId is falsy", async () => {
    await expect(
      dataService.archiveDataItem(undefined, ITEM_A.id),
    ).rejects.toThrow(/requires clientId/);
  });

  it("deleteDataItem throws when clientId is falsy", async () => {
    await expect(dataService.deleteDataItem("", ITEM_A.id)).rejects.toThrow(
      /requires clientId/,
    );
  });

  it("getOpportunitiesForItem throws when clientId is falsy", async () => {
    await expect(
      opportunityService.getOpportunitiesForItem(null, ITEM_A.id),
    ).rejects.toThrow(/requires clientId/);
  });
});
