// Spinstr02 — generic data-import path now dedups PROPERTY rows
// at intake the same way the dedicated listingIngestion path does.
//
// Pins:
//   - PROPERTY rows that share an address / MLS id / listingUrl
//     collapse onto the first row created in the batch.
//   - Cross-import dedup: a PROPERTY that matches an existing
//     ACTIVE row in the workspace merges into it instead of
//     creating a second row.
//   - Merge is "prefer richer": non-null fields from the new
//     payload fill gaps in the existing dataJson but don't clobber
//     non-null existing values.
//   - Non-PROPERTY items are unaffected.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { saveImportedItems } = await import(
  "../domains/studio/dataImport.service.js"
);

function buildMock({ existing = [] } = {}) {
  const created = [];
  const updates = [];
  let nextId = 1;
  prismaMock = {
    workspaceDataSource: {
      create: vi.fn(async ({ data }) => ({ id: `ds-${data.clientId}`, ...data })),
    },
    workspaceDataItem: {
      findMany: vi.fn(async ({ where }) => {
        if (where?.type === "PROPERTY") {
          return existing.filter((r) => r.status === "ACTIVE");
        }
        return created.map((c) => ({ id: c.id, type: c.type, title: c.title }));
      }),
      findUnique: vi.fn(async ({ where }) => {
        const fromExisting = existing.find((r) => r.id === where.id);
        if (fromExisting) return fromExisting;
        return created.find((r) => r.id === where.id) ?? null;
      }),
      create: vi.fn(async ({ data, select }) => {
        const row = { id: `new-${nextId++}`, ...data };
        created.push(row);
        if (select) {
          const projected = {};
          for (const k of Object.keys(select)) if (select[k]) projected[k] = row[k];
          return projected;
        }
        return row;
      }),
      createMany: vi.fn(async ({ data }) => {
        for (const d of data) created.push({ id: `bulk-${nextId++}`, ...d });
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }) => {
        const target = existing.find((r) => r.id === where.id);
        if (target) Object.assign(target, data);
        updates.push({ id: where.id, data });
        return target ?? { id: where.id, ...data };
      }),
    },
  };
  return { created, updates };
}

beforeEach(() => {
  // ensure mocks reset
});

describe("saveImportedItems — PROPERTY dedup", () => {
  it("collapses two PROPERTY items in the same batch that share an address", async () => {
    const { created } = buildMock();
    const result = await saveImportedItems("client-1", {
      sourceType: "manual_import",
      items: [
        {
          type: "PROPERTY",
          title: "508 King George Court, Springboro, OH",
          dataJson: { address: "508 King George Court", price: 425000 },
        },
        {
          type: "PROPERTY",
          title: "508 King George Court",
          dataJson: {
            address: "508 King George Court",
            imageUrl: "https://cdn/photo.jpg",
            images: ["https://cdn/photo.jpg"],
          },
        },
      ],
    });
    expect(result.created).toBe(1);
    expect(result.propertyMerged).toBe(1);
    expect(created.filter((c) => c.type === "PROPERTY")).toHaveLength(1);
  });

  it("merges into an existing ACTIVE workspace PROPERTY instead of creating a duplicate", async () => {
    const existing = [
      {
        id: "existing-1",
        type: "PROPERTY",
        status: "ACTIVE",
        title: "508 King George Court",
        dataJson: { address: "508 King George Court", price: 425000 },
      },
    ];
    const { updates, created } = buildMock({ existing });
    const result = await saveImportedItems("client-1", {
      sourceType: "url_import",
      items: [
        {
          type: "PROPERTY",
          title: "508 King George Court, Springboro, OH",
          dataJson: {
            address: "508 King George Court",
            imageUrl: "https://cdn/photo.jpg",
            bedrooms: 4,
          },
        },
      ],
    });
    expect(result.created).toBe(0);
    expect(result.propertyMerged).toBe(1);
    expect(created.filter((c) => c.type === "PROPERTY")).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("existing-1");
    // Merge is gap-fill: image + bedrooms fill the existing record.
    expect(updates[0].data.dataJson.imageUrl).toBe("https://cdn/photo.jpg");
    expect(updates[0].data.dataJson.bedrooms).toBe(4);
    // ...and doesn't clobber the existing price.
    expect(updates[0].data.dataJson.price).toBe(425000);
  });

  it("dedups on externalListingId / MLS id when present", async () => {
    const existing = [
      {
        id: "existing-2",
        type: "PROPERTY",
        status: "ACTIVE",
        title: "873 E Us 22 & 3",
        dataJson: { externalListingId: "MLS-42", address: "873 E Us 22" },
      },
    ];
    const { updates, created } = buildMock({ existing });
    const result = await saveImportedItems("client-1", {
      sourceType: "csv_import",
      items: [
        {
          type: "PROPERTY",
          title: "Different title same MLS",
          dataJson: { mlsId: "MLS-42", price: 550000 },
        },
      ],
    });
    expect(result.created).toBe(0);
    expect(result.propertyMerged).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("existing-2");
    expect(created.filter((c) => c.type === "PROPERTY")).toHaveLength(0);
  });

  it("does not dedup non-PROPERTY items (testimonials may repeat)", async () => {
    const { created } = buildMock();
    const result = await saveImportedItems("client-1", {
      sourceType: "manual_import",
      items: [
        {
          type: "TESTIMONIAL",
          title: "Great agent",
          dataJson: { reviewer: "Alice", body: "Loved working with them" },
        },
        {
          type: "TESTIMONIAL",
          title: "Great agent",
          dataJson: { reviewer: "Bob", body: "Loved working with them" },
        },
      ],
    });
    expect(result.created).toBe(2);
    expect(result.propertyMerged).toBe(0);
    expect(created).toHaveLength(2);
  });

  it("creates separate rows when properties have distinct addresses", async () => {
    const { created } = buildMock();
    const result = await saveImportedItems("client-1", {
      sourceType: "csv_import",
      items: [
        {
          type: "PROPERTY",
          title: "508 King George Court",
          dataJson: { address: "508 King George Court" },
        },
        {
          type: "PROPERTY",
          title: "873 E Us 22 & 3",
          dataJson: { address: "873 E Us 22 & 3" },
        },
      ],
    });
    expect(result.created).toBe(2);
    expect(result.propertyMerged).toBe(0);
    expect(created.filter((c) => c.type === "PROPERTY")).toHaveLength(2);
  });
});
