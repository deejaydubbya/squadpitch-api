// Autopilot Phase 4 — approve (+ optional schedule) workflow.
//
// Pins the contract from docs/AUTOPILOT_PRODUCT_AUDIT.md §11
// (Phase 4 completion note):
//   - refuses without generated drafts
//   - refuses DISMISSED / EXPIRED recommendations
//   - tenant-isolated
//   - transitions child drafts via draftWorkflow (APPROVED)
//   - optional scheduleAt fans out via draftWorkflow.scheduleDraft
//   - idempotent — already-APPROVED / SCHEDULED drafts are skipped
//   - no publish path
//   - all-children-already-past → rec flips appropriately

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
let approveDraftMock;
let scheduleDraftMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../lib/auditLog.js", () => ({
  writeAudit: vi.fn(),
}));

vi.mock("../domains/studio/draftWorkflow.service.js", () => ({
  approveDraft: (...args) => approveDraftMock(...args),
  scheduleDraft: (...args) => scheduleDraftMock(...args),
}));

const svc = await import(
  "../domains/studio/autopilotCampaignRecommendation.service.js"
);

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

function makeMock({ recs = [], drafts = [] } = {}) {
  const recsMap = new Map(recs.map((r) => [r.id, r]));
  const draftsMap = new Map(drafts.map((d) => [d.id, d]));
  return {
    state: { recs: recsMap, drafts: draftsMap },
    autopilotCampaignRecommendation: {
      findFirst: vi.fn(async ({ where }) => {
        const r = recsMap.get(where.id);
        if (!r) return null;
        if (where.clientId && r.clientId !== where.clientId) return null;
        return r;
      }),
      update: vi.fn(async ({ where, data }) => {
        const r = recsMap.get(where.id);
        Object.assign(r, data);
        return r;
      }),
    },
    draft: {
      findMany: vi.fn(async ({ where }) => {
        const ids = where?.id?.in ?? [];
        return ids
          .map((id) => draftsMap.get(id))
          .filter((d) => d && d.clientId === where.clientId);
      }),
    },
  };
}

function baseRec(extra = {}) {
  return {
    id: "rec-1",
    clientId: CLIENT_A,
    status: "DRAFT_GENERATED",
    triggerType: "NEW_LISTING",
    triggerObjectType: "listing",
    triggerObjectId: "listing-1",
    headline: "h",
    whatWeNoticed: "w",
    whyItMatters: "y",
    recommendedChannels: ["INSTAGRAM", "FACEBOOK"],
    recommendedAngles: [],
    generatedDraftIds: ["d-1", "d-2"],
    payloadJson: {},
    ...extra,
  };
}
function baseDraft(extra = {}) {
  return {
    id: "d-1",
    clientId: CLIENT_A,
    status: "DRAFT",
    channel: "INSTAGRAM",
    scheduledFor: null,
    ...extra,
  };
}

beforeEach(() => {
  prismaMock = null;
  approveDraftMock = vi.fn(async (id) => {
    const d = prismaMock.state.drafts.get(id);
    if (!d) throw new Error("not found");
    d.status = "APPROVED";
    return d;
  });
  scheduleDraftMock = vi.fn(async (id, when) => {
    const d = prismaMock.state.drafts.get(id);
    if (!d) throw new Error("not found");
    d.status = "SCHEDULED";
    d.scheduledFor = when;
    return d;
  });
});

describe("approveRecommendation — happy path", () => {
  it("approves every child draft and flips rec status to APPROVED", async () => {
    prismaMock = makeMock({
      recs: [baseRec()],
      drafts: [baseDraft({ id: "d-1" }), baseDraft({ id: "d-2", channel: "FACEBOOK" })],
    });
    const result = await svc.approveRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("success");
    expect(result.drafts.length).toBe(2);
    expect(approveDraftMock).toHaveBeenCalledTimes(2);
    expect(scheduleDraftMock).not.toHaveBeenCalled();
    expect(prismaMock.state.recs.get("rec-1").status).toBe("APPROVED");
  });

  it("schedules each draft when scheduleAt is provided and flips rec to SCHEDULED", async () => {
    prismaMock = makeMock({
      recs: [baseRec()],
      drafts: [baseDraft({ id: "d-1" }), baseDraft({ id: "d-2", channel: "FACEBOOK" })],
    });
    const when = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const result = await svc.approveRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
      scheduleAt: when,
    });
    expect(result.status).toBe("success");
    expect(scheduleDraftMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.state.recs.get("rec-1").status).toBe("SCHEDULED");
  });
});

describe("approveRecommendation — idempotency", () => {
  it("skips drafts already past APPROVED, doesn't call approveDraft on them", async () => {
    prismaMock = makeMock({
      recs: [baseRec({ status: "APPROVED" })],
      drafts: [
        baseDraft({ id: "d-1", status: "APPROVED" }),
        baseDraft({ id: "d-2", channel: "FACEBOOK", status: "SCHEDULED" }),
      ],
    });
    const result = await svc.approveRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(approveDraftMock).not.toHaveBeenCalled();
    expect(scheduleDraftMock).not.toHaveBeenCalled();
    expect(result.status).toBe("success"); // all past APPROVED
  });

  it("scheduleAt re-schedules a different time but not the same time", async () => {
    const when = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    prismaMock = makeMock({
      recs: [baseRec()],
      drafts: [
        baseDraft({ id: "d-1", status: "SCHEDULED", scheduledFor: when }),
        baseDraft({ id: "d-2", channel: "FACEBOOK", status: "DRAFT" }),
      ],
    });
    await svc.approveRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
      scheduleAt: when, // identical to d-1's existing time
    });
    // d-1 is already SCHEDULED at that time — no scheduleDraft call
    // for it. d-2 needs both approve + schedule.
    expect(approveDraftMock).toHaveBeenCalledWith("d-2", "auth0|alice");
    expect(scheduleDraftMock).toHaveBeenCalledWith("d-2", when, "auth0|alice");
    expect(scheduleDraftMock).not.toHaveBeenCalledWith("d-1", when, "auth0|alice");
  });
});

describe("approveRecommendation — refusal", () => {
  it("refuses when the rec has no generated drafts (NO_GENERATED_DRAFTS)", async () => {
    prismaMock = makeMock({
      recs: [baseRec({ generatedDraftIds: [] })],
    });
    await expect(
      svc.approveRecommendation({
        clientId: CLIENT_A,
        recommendationId: "rec-1",
        userId: "auth0|alice",
      }),
    ).rejects.toMatchObject({ code: "NO_GENERATED_DRAFTS", status: 400 });
  });

  it("refuses on DISMISSED", async () => {
    prismaMock = makeMock({ recs: [baseRec({ status: "DISMISSED" })] });
    await expect(
      svc.approveRecommendation({
        clientId: CLIENT_A,
        recommendationId: "rec-1",
        userId: "auth0|alice",
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_ELIGIBLE" });
  });

  it("refuses on EXPIRED", async () => {
    prismaMock = makeMock({ recs: [baseRec({ status: "EXPIRED" })] });
    await expect(
      svc.approveRecommendation({
        clientId: CLIENT_A,
        recommendationId: "rec-1",
        userId: "auth0|alice",
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_ELIGIBLE" });
  });

  it("refuses cross-workspace with 404 — no draft mutations", async () => {
    prismaMock = makeMock({
      recs: [baseRec()],
      drafts: [baseDraft({ id: "d-1" }), baseDraft({ id: "d-2" })],
    });
    await expect(
      svc.approveRecommendation({
        clientId: CLIENT_B,
        recommendationId: "rec-1",
        userId: "auth0|alice",
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_FOUND", status: 404 });
    expect(approveDraftMock).not.toHaveBeenCalled();
  });
});

describe("approveRecommendation — never publishes", () => {
  it("does not transition any draft to PUBLISHED", async () => {
    prismaMock = makeMock({
      recs: [baseRec()],
      drafts: [baseDraft({ id: "d-1" }), baseDraft({ id: "d-2", channel: "FACEBOOK" })],
    });
    await svc.approveRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    for (const d of prismaMock.state.drafts.values()) {
      expect(d.status).not.toBe("PUBLISHED");
    }
  });
});

describe("approveRecommendation — partial failure", () => {
  it("captures per-draft errors and reports status=partial_success", async () => {
    approveDraftMock = vi.fn(async (id) => {
      if (id === "d-2") {
        const e = new Error("draft state machine refused");
        throw e;
      }
      const d = prismaMock.state.drafts.get(id);
      d.status = "APPROVED";
      return d;
    });
    prismaMock = makeMock({
      recs: [baseRec()],
      drafts: [baseDraft({ id: "d-1" }), baseDraft({ id: "d-2", channel: "FACEBOOK" })],
    });
    const result = await svc.approveRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("partial_success");
    const errored = result.drafts.find((d) => d.draftId === "d-2");
    expect(errored.error).toMatch(/refused/);
    // Rec doesn't flip to APPROVED if any child errored out.
    expect(prismaMock.state.recs.get("rec-1").status).toBe("DRAFT_GENERATED");
  });
});
