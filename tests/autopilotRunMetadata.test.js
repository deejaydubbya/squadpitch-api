// Spinstr04 — listRuns now exposes a sanitized `metadata` blob
// so the activity panel can render skip reasons + summary counts.
//
// Pins:
//   - Whitelist: only `summary`, `autoGenerate`, `schedulerTickId`
//     pass through. Any other key (today or future) is stripped.
//   - Returns null when nothing whitelisted is present (vs an
//     empty object, which would lie about there being data).
//   - Falsy metadata values (null, primitive, array) → null.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { listRuns } = await import("../domains/studio/autopilotRun.service.js");

beforeEach(() => {
  prismaMock = {
    autopilotRun: {
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
  };
});

function runRow({ metadata }) {
  return {
    id: "r1",
    triggerSource: "SCHEDULED",
    status: "CREATED_RECOMMENDATIONS",
    reason: "Surfaced 2 opportunities",
    recommendationsCreated: 2,
    recommendationsUpdated: 0,
    recommendationsExpired: 0,
    startedAt: new Date("2026-05-18T12:00:00Z"),
    finishedAt: new Date("2026-05-18T12:00:05Z"),
    errorMessage: null,
    metadata,
  };
}

describe("listRuns — metadata sanitizer", () => {
  it("passes the whitelisted summary + autoGenerate keys through", async () => {
    prismaMock.autopilotRun.findMany.mockResolvedValue([
      runRow({
        metadata: {
          summary: {
            eligibleListings: 5,
            duplicatesSuppressed: 2,
            listingsCappedByRunLimit: 0,
          },
          autoGenerate: {
            draftsCreated: 3,
            skipped: [{ recommendationId: "r-1", reason: "no source" }],
          },
        },
      }),
    ]);
    const result = await listRuns({ clientId: "c1" });
    expect(result.runs[0].metadata).toEqual({
      summary: {
        eligibleListings: 5,
        duplicatesSuppressed: 2,
        listingsCappedByRunLimit: 0,
      },
      autoGenerate: {
        draftsCreated: 3,
        skipped: [{ recommendationId: "r-1", reason: "no source" }],
      },
    });
  });

  it("strips non-whitelisted keys (defense against future detector experiments)", async () => {
    prismaMock.autopilotRun.findMany.mockResolvedValue([
      runRow({
        metadata: {
          summary: { eligibleListings: 1 },
          internalDebugDump: { sql: "SELECT *", contactEmail: "x@y.com" },
        },
      }),
    ]);
    const result = await listRuns({ clientId: "c1" });
    expect(result.runs[0].metadata).toEqual({
      summary: { eligibleListings: 1 },
    });
    expect(result.runs[0].metadata).not.toHaveProperty("internalDebugDump");
  });

  it("returns null metadata when nothing whitelisted is present", async () => {
    prismaMock.autopilotRun.findMany.mockResolvedValue([
      runRow({ metadata: { somethingElse: 1 } }),
    ]);
    const result = await listRuns({ clientId: "c1" });
    expect(result.runs[0].metadata).toBeNull();
  });

  it("returns null when metadata is null / primitive / array", async () => {
    prismaMock.autopilotRun.findMany.mockResolvedValue([
      runRow({ metadata: null }),
      runRow({ metadata: "hello" }),
      runRow({ metadata: [1, 2, 3] }),
    ]);
    const result = await listRuns({ clientId: "c1" });
    expect(result.runs[0].metadata).toBeNull();
    expect(result.runs[1].metadata).toBeNull();
    expect(result.runs[2].metadata).toBeNull();
  });

  it("preserves the rest of the row shape", async () => {
    prismaMock.autopilotRun.findMany.mockResolvedValue([
      runRow({ metadata: { summary: { eligibleListings: 1 } } }),
    ]);
    const result = await listRuns({ clientId: "c1" });
    expect(result.runs[0]).toMatchObject({
      id: "r1",
      triggerSource: "scheduled",
      status: "created_recommendations",
      recommendationsCreated: 2,
    });
    expect(result.runs[0].startedAt).toBe("2026-05-18T12:00:00.000Z");
  });
});
