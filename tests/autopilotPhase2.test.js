// Autopilot Phase 2 — campaign recommendation persistence.
//
// Pins the contract for the new
// `AutopilotCampaignRecommendation` service: idempotent upsert,
// user-decided rows stay sticky, list/stats default behavior,
// dismiss is idempotent + tenant-isolated.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
let auditCalls;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../lib/auditLog.js", () => ({
  writeAudit: vi.fn(async (req, entry) => {
    auditCalls.push(entry);
  }),
}));

const svc = await import(
  "../domains/studio/autopilotCampaignRecommendation.service.js"
);

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

function makeMock() {
  const rows = new Map();
  let counter = 0;
  return {
    state: { rows },
    autopilotCampaignRecommendation: {
      findFirst: vi.fn(async ({ where }) => {
        for (const r of rows.values()) {
          if (where.clientId && r.clientId !== where.clientId) continue;
          if (where.id && r.id !== where.id) continue;
          if (where.triggerType && r.triggerType !== where.triggerType) continue;
          if (
            "triggerObjectId" in where &&
            r.triggerObjectId !== where.triggerObjectId
          )
            continue;
          return { ...r };
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }) => rows.get(where.id) ?? null),
      findMany: vi.fn(async ({ where = {}, take, skip = 0, orderBy } = {}) => {
        const filtered = [...rows.values()].filter((r) => {
          if (where.clientId && r.clientId !== where.clientId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (where.status?.not && r.status === where.status.not) return false;
          if (typeof where.status === "string" && r.status !== where.status) return false;
          return true;
        });
        // Stable order: newest first.
        filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return filtered.slice(skip, skip + (take ?? filtered.length));
      }),
      count: vi.fn(async ({ where = {} } = {}) => {
        return [...rows.values()].filter((r) => {
          if (where.clientId && r.clientId !== where.clientId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (where.status?.not && r.status === where.status.not) return false;
          if (typeof where.status === "string" && r.status !== where.status) return false;
          if (where.updatedAt?.gte && new Date(r.updatedAt) < where.updatedAt.gte)
            return false;
          return true;
        }).length;
      }),
      create: vi.fn(async ({ data }) => {
        // Enforce the unique constraint at the mock level so the
        // race-fallback branch is exercised.
        for (const r of rows.values()) {
          if (
            r.clientId === data.clientId &&
            r.triggerType === data.triggerType &&
            r.triggerObjectId === data.triggerObjectId
          ) {
            const err = new Error("Unique constraint violation");
            err.code = "P2002";
            throw err;
          }
        }
        const id = `rec-${++counter}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: "NEEDS_REVIEW",
          generatedDraftIds: [],
          ...data,
        };
        rows.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let n = 0;
        for (const r of rows.values()) {
          if (where.clientId && r.clientId !== where.clientId) continue;
          if (where.status?.in && !where.status.in.includes(r.status)) continue;
          if (where.expiresAt?.lt && (!r.expiresAt || new Date(r.expiresAt) >= where.expiresAt.lt))
            continue;
          Object.assign(r, data);
          n += 1;
        }
        return { count: n };
      }),
    },
  };
}

beforeEach(() => {
  prismaMock = makeMock();
  auditCalls = [];
});

function baseRec(extra = {}) {
  return {
    clientId: CLIENT_A,
    triggerType: "NEW_LISTING",
    triggerObjectId: "listing-1",
    triggerObjectType: "listing",
    headline: "New listing launch — 123 Main St",
    whatWeNoticed: "You added a new listing on 2026-05-18.",
    whyItMatters: "First-7-days engagement is highest.",
    recommendedChannels: ["INSTAGRAM", "FACEBOOK"],
    recommendedAngles: ["a", "b"],
    ...extra,
  };
}

describe("upsertRecommendation — idempotency", () => {
  it("creates a new row on first call", async () => {
    const r = await svc.upsertRecommendation(baseRec());
    expect(r.status).toBe("created");
    expect(prismaMock.state.rows.size).toBe(1);
  });

  it("updates the row when called again with the same trigger key", async () => {
    await svc.upsertRecommendation(baseRec());
    const r2 = await svc.upsertRecommendation(
      baseRec({ headline: "Updated headline", whatWeNoticed: "newer text" }),
    );
    expect(r2.status).toBe("updated");
    expect(prismaMock.state.rows.size).toBe(1);
    const stored = [...prismaMock.state.rows.values()][0];
    expect(stored.headline).toBe("Updated headline");
  });

  it("does not re-open a DISMISSED row on subsequent detector runs", async () => {
    const r1 = await svc.upsertRecommendation(baseRec());
    // User dismisses.
    await svc.dismissRecommendation({
      clientId: CLIENT_A,
      recommendationId: r1.recommendationId,
      reason: "not relevant",
    });
    // Detector re-fires the same opportunity.
    const r2 = await svc.upsertRecommendation(
      baseRec({ headline: "Updated headline (detector pass 2)" }),
    );
    expect(r2.status).toBe("noop");
    const stored = [...prismaMock.state.rows.values()][0];
    expect(stored.status).toBe("DISMISSED");
    // Sticky — headline NOT changed because the user already decided.
    expect(stored.headline).toBe("New listing launch — 123 Main St");
  });

  it("scopes by clientId — same trigger in workspace B is a separate row", async () => {
    await svc.upsertRecommendation(baseRec());
    await svc.upsertRecommendation(baseRec({ clientId: CLIENT_B }));
    expect(prismaMock.state.rows.size).toBe(2);
  });
});

describe("listRecommendations + getStats — defaults", () => {
  it("empty workspace returns empty list, not an error", async () => {
    const { recommendations, total } = await svc.listRecommendations({
      clientId: CLIENT_A,
    });
    expect(recommendations).toEqual([]);
    expect(total).toBe(0);
  });

  it("empty workspace returns zero stats, not an error", async () => {
    const stats = await svc.getStats(CLIENT_A);
    expect(stats).toEqual({
      pendingCount: 0,
      readyCount: 0,
      approvedThisWeek: 0,
      dismissedThisWeek: 0,
      convertedThisWeek: 0,
    });
  });

  it("default list excludes EXPIRED rows", async () => {
    const r = await svc.upsertRecommendation(baseRec());
    prismaMock.state.rows.get(r.recommendationId).status = "EXPIRED";
    const { recommendations } = await svc.listRecommendations({ clientId: CLIENT_A });
    expect(recommendations.length).toBe(0);
  });

  it("includeExpired=true surfaces them", async () => {
    const r = await svc.upsertRecommendation(baseRec());
    prismaMock.state.rows.get(r.recommendationId).status = "EXPIRED";
    const { recommendations } = await svc.listRecommendations({
      clientId: CLIENT_A,
      includeExpired: true,
    });
    expect(recommendations.length).toBe(1);
  });

  it("filters by an array of statuses (route-layer mapped from FE labels)", async () => {
    const r = await svc.upsertRecommendation(baseRec());
    prismaMock.state.rows.get(r.recommendationId).status = "DRAFT_GENERATED";
    const { recommendations } = await svc.listRecommendations({
      clientId: CLIENT_A,
      status: ["DRAFT_GENERATED"],
    });
    expect(recommendations.length).toBe(1);
  });
});

describe("dismissRecommendation — tenant isolation + idempotency", () => {
  it("dismisses a row, recording the reason and actor", async () => {
    const r = await svc.upsertRecommendation(baseRec());
    const out = await svc.dismissRecommendation({
      clientId: CLIENT_A,
      recommendationId: r.recommendationId,
      reason: "tried this last week",
      actorSub: "auth0|alice",
    });
    expect(out.status).toBe("dismissed");
    expect(out.dismissedReason).toBe("tried this last week");
    expect(out.decidedBy).toBe("auth0|alice");
  });

  it("refuses cross-workspace dismiss (404, no row mutation)", async () => {
    const r = await svc.upsertRecommendation(baseRec()); // workspace A
    await expect(
      svc.dismissRecommendation({
        clientId: CLIENT_B,
        recommendationId: r.recommendationId,
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_FOUND" });
    const stored = prismaMock.state.rows.get(r.recommendationId);
    expect(stored.status).toBe("NEEDS_REVIEW");
  });

  it("is idempotent — dismissing an already-dismissed row succeeds", async () => {
    const r = await svc.upsertRecommendation(baseRec());
    await svc.dismissRecommendation({
      clientId: CLIENT_A,
      recommendationId: r.recommendationId,
    });
    // Second call shouldn't throw.
    const out = await svc.dismissRecommendation({
      clientId: CLIENT_A,
      recommendationId: r.recommendationId,
      reason: "second time clicking",
    });
    expect(out.status).toBe("dismissed");
  });
});

describe("toFrontendShape — listing-centric mapping", () => {
  it("maps payload fields into the FE-shaped propertyTitle / propertyAddress", async () => {
    const r = await svc.upsertRecommendation(
      baseRec({
        payloadJson: {
          propertyTitle: "123 Main St",
          propertyAddress: "Cary, NC",
          confidence: "high",
        },
      }),
    );
    const stored = prismaMock.state.rows.get(r.recommendationId);
    const out = svc.toFrontendShape(stored);
    expect(out.propertyTitle).toBe("123 Main St");
    expect(out.propertyAddress).toBe("Cary, NC");
    expect(out.confidence).toBe("high");
    expect(out.status).toBe("pending");
    expect(out.triggerType).toBe("new_listing");
  });

  it("falls back to confidence='medium' on unrecognized values", async () => {
    const r = await svc.upsertRecommendation(
      baseRec({ payloadJson: { confidence: "uncertain" } }),
    );
    const stored = prismaMock.state.rows.get(r.recommendationId);
    expect(svc.toFrontendShape(stored).confidence).toBe("medium");
  });
});
