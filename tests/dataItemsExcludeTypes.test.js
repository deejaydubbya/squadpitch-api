// Spinstr425 — listDataItems gains an excludeTypes filter so the
// Content Assets surface can keep PROPERTY rows out of the
// generic asset view. Property rows live on the dedicated
// Properties tab; they still flow into the Autopilot detector
// via its own query (autopilot reads type IN [PROPERTY, CUSTOM]).
//
// Pins:
//   - excludeTypes sets where.type = { notIn }.
//   - The explicit `type` filter wins over excludeTypes.
//   - excludeTypes works on a single value or an array.
//   - Schema-validated against DataItemType enum (invalid names
//     get filtered out rather than passed through).

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
let lastWhere;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { listDataItems } = await import("../domains/studio/data.service.js");
const { ListDataItemsQuerySchema } = await import(
  "../domains/studio/studio.schemas.js"
);

beforeEach(() => {
  lastWhere = null;
  prismaMock = {
    workspaceDataItem: {
      findMany: vi.fn(async ({ where }) => {
        lastWhere = where;
        return [];
      }),
    },
  };
});

describe("listDataItems — excludeTypes", () => {
  it("adds notIn when excludeTypes is provided", async () => {
    await listDataItems("c1", { excludeTypes: ["PROPERTY"] });
    expect(lastWhere.type).toEqual({ notIn: ["PROPERTY"] });
  });

  it("supports multiple exclusions", async () => {
    await listDataItems("c1", { excludeTypes: ["PROPERTY", "CUSTOM"] });
    expect(lastWhere.type).toEqual({ notIn: ["PROPERTY", "CUSTOM"] });
  });

  it("ignores excludeTypes when an explicit type is passed", async () => {
    await listDataItems("c1", { type: "TESTIMONIAL", excludeTypes: ["PROPERTY"] });
    expect(lastWhere.type).toBe("TESTIMONIAL");
  });

  it("does not set type when neither type nor excludeTypes is passed", async () => {
    await listDataItems("c1", {});
    expect(lastWhere.type).toBeUndefined();
  });

  it("ignores an empty excludeTypes array", async () => {
    await listDataItems("c1", { excludeTypes: [] });
    expect(lastWhere.type).toBeUndefined();
  });
});

describe("ListDataItemsQuerySchema — excludeTypes parsing", () => {
  it("accepts a comma-separated string", () => {
    const parsed = ListDataItemsQuerySchema.parse({ excludeTypes: "PROPERTY,CUSTOM" });
    expect(parsed.excludeTypes).toEqual(["PROPERTY", "CUSTOM"]);
  });

  it("accepts an array (repeated query param)", () => {
    const parsed = ListDataItemsQuerySchema.parse({ excludeTypes: ["PROPERTY", "CUSTOM"] });
    expect(parsed.excludeTypes).toEqual(["PROPERTY", "CUSTOM"]);
  });

  it("filters out invalid enum values", () => {
    const parsed = ListDataItemsQuerySchema.parse({ excludeTypes: "PROPERTY,bogus,CUSTOM" });
    expect(parsed.excludeTypes).toEqual(["PROPERTY", "CUSTOM"]);
  });

  it("becomes undefined when no valid values remain", () => {
    const parsed = ListDataItemsQuerySchema.parse({ excludeTypes: "junk,nope" });
    expect(parsed.excludeTypes).toBeUndefined();
  });

  it("is optional", () => {
    const parsed = ListDataItemsQuerySchema.parse({});
    expect(parsed.excludeTypes).toBeUndefined();
  });
});
