// Autopilot Phase 6 — end-to-end workflow integration.
//
// Walks the full chain via service calls:
//   1. upsertRecommendation creates a NEEDS_REVIEW row
//   2. listRecommendations + getStats reflect the new row
//   3. dismissRecommendation flips one rec → DISMISSED (sticky)
//   4. generateDraftsForRecommendation on another rec fans out
//      drafts + flips it → DRAFT_GENERATED
//   5. approveRecommendation transitions every child draft via
//      draftWorkflow + flips the rec → APPROVED
//
// Plus the non-negotiable: at no point does any draft transition
// to PUBLISHED, and no recommendation reaches SCHEDULED unless
// the caller passes scheduleAt.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../lib/auditLog.js", () => ({ writeAudit: vi.fn() }));

const approveCalls = [];
const scheduleCalls = [];
vi.mock("../domains/studio/draftWorkflow.service.js", () => ({
  approveDraft: vi.fn(async (id, sub) => {
    approveCalls.push({ id, sub });
    const d = prismaMock.state.drafts.get(id);
    d.status = "APPROVED";
    return d;
  }),
  scheduleDraft: vi.fn(async (id, when, sub) => {
    scheduleCalls.push({ id, when, sub });
    const d = prismaMock.state.drafts.get(id);
    d.status = "SCHEDULED";
    d.scheduledFor = when;
    return d;
  }),
}));

vi.mock("../domains/studio/generation/aiGenerationService.js", () => ({
  generateDraft: vi.fn(async ({ clientId, channel }) => {
    const d = {
      id: `draft-${prismaMock.state.drafts.size + 1}`,
      clientId,
      channel,
      status: "DRAFT",
      bucketKey: "just_listed",
    };
    prismaMock.state.drafts.set(d.id, d);
    return d;
  }),
}));

const svc = await import(
  "../domains/studio/autopilotCampaignRecommendation.service.js"
);

const CLIENT_ID = "client-e2e";

function makeMock() {
  const recs = new Map();
  const drafts = new Map();
  let recCounter = 0;
  return {
    state: { recs, drafts },
    autopilotCampaignRecommendation: {
      findFirst: vi.fn(async ({ where }) => {
        for (const r of recs.values()) {
          if (where.clientId && r.clientId !== where.clientId) continue;
          if (where.id && r.id !== where.id) continue;
          if (where.triggerType && r.triggerType !== where.triggerType) continue;
          if (
            "triggerObjectId" in where &&
            r.triggerObjectId !== where.triggerObjectId
          )
            continue;
          return r;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }) => recs.get(where.id) ?? null),
      findMany: vi.fn(async ({ where = {} } = {}) => {
        return [...recs.values()].filter((r) => {
          if (where.clientId && r.clientId !== where.clientId) return false;
          if (where.status?.not && r.status === where.status.not) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        });
      }),
      count: vi.fn(async ({ where = {} } = {}) => {
        return [...recs.values()].filter((r) => {
          if (where.clientId && r.clientId !== where.clientId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (typeof where.status === "string" && r.status !== where.status) return false;
          return true;
        }).length;
      }),
      create: vi.fn(async ({ data }) => {
        for (const r of recs.values()) {
          if (
            r.clientId === data.clientId &&
            r.triggerType === data.triggerType &&
            r.triggerObjectId === data.triggerObjectId
          ) {
            const e = new Error("dup");
            e.code = "P2002";
            throw e;
          }
        }
        const id = `rec-${++recCounter}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: "NEEDS_REVIEW",
          generatedDraftIds: [],
          ...data,
        };
        recs.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const r = recs.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    draft: {
      findMany: vi.fn(async ({ where }) => {
        const ids = where?.id?.in ?? [];
        return ids.map((id) => drafts.get(id)).filter((d) => d && d.clientId === where.clientId);
      }),
    },
    channelSettings: {
      findMany: vi.fn(async () => [
        { channel: "INSTAGRAM" },
        { channel: "FACEBOOK" },
      ]),
    },
  };
}

beforeEach(() => {
  prismaMock = makeMock();
  approveCalls.length = 0;
  scheduleCalls.length = 0;
});

describe("Autopilot end-to-end — Inbox → Generate → Approve", () => {
  it("walks the full lifecycle without publishing anything", async () => {
    // 1. Detector emits two recommendations.
    const recDismissed = await svc.upsertRecommendation({
      clientId: CLIENT_ID,
      triggerType: "NEW_LISTING",
      triggerObjectType: "listing",
      triggerObjectId: "listing-101",
      headline: "New listing — 101 Maple",
      whatWeNoticed: "Listing added.",
      whyItMatters: "First-7-days engagement is highest.",
      recommendedChannels: ["INSTAGRAM", "FACEBOOK"],
      recommendedAngles: [],
      payloadJson: { propertyImageUrl: "https://example.com/x.jpg" },
    });
    const recActive = await svc.upsertRecommendation({
      clientId: CLIENT_ID,
      triggerType: "OPEN_HOUSE",
      triggerObjectType: "listing",
      triggerObjectId: "listing-202",
      headline: "Open house Saturday — 202 Oak",
      whatWeNoticed: "Open house this weekend.",
      whyItMatters: "Reminders 3 days out drive turnout.",
      recommendedChannels: ["INSTAGRAM", "FACEBOOK"],
      recommendedAngles: [],
      payloadJson: { propertyImageUrl: "https://example.com/y.jpg" },
    });
    expect(prismaMock.state.recs.size).toBe(2);

    // 2. List + stats reflect them.
    const list = await svc.listRecommendations({ clientId: CLIENT_ID });
    expect(list.recommendations.length).toBe(2);
    const stats = await svc.getStats(CLIENT_ID);
    expect(stats.pendingCount).toBe(2);

    // 3. Dismiss the first rec — sticky, won't be re-opened on
    //    detector re-runs.
    await svc.dismissRecommendation({
      clientId: CLIENT_ID,
      recommendationId: recDismissed.recommendationId,
      reason: "not relevant",
    });
    expect(prismaMock.state.recs.get(recDismissed.recommendationId).status).toBe(
      "DISMISSED",
    );
    // Re-detection on the dismissed key must NOT reopen it.
    const reDetect = await svc.upsertRecommendation({
      clientId: CLIENT_ID,
      triggerType: "NEW_LISTING",
      triggerObjectType: "listing",
      triggerObjectId: "listing-101",
      headline: "Refreshed headline (should be ignored)",
      whatWeNoticed: "Still here.",
      whyItMatters: "Still matters.",
      recommendedChannels: [],
      recommendedAngles: [],
    });
    expect(reDetect.status).toBe("noop");
    expect(
      prismaMock.state.recs.get(recDismissed.recommendationId).status,
    ).toBe("DISMISSED");
    expect(
      prismaMock.state.recs.get(recDismissed.recommendationId).headline,
    ).toBe("New listing — 101 Maple"); // unchanged

    // 4. Generate drafts on the active rec.
    const gen = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_ID,
      recommendationId: recActive.recommendationId,
      userId: "auth0|alice",
    });
    expect(gen.status).toBe("success");
    expect(gen.drafts.length).toBe(2);
    expect(prismaMock.state.recs.get(recActive.recommendationId).status).toBe(
      "DRAFT_GENERATED",
    );
    // Repeat click is idempotent — same drafts back, no new ones.
    const gen2 = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_ID,
      recommendationId: recActive.recommendationId,
      userId: "auth0|alice",
    });
    expect(gen2.status).toBe("noop");
    expect(gen2.alreadyGenerated).toBe(true);

    // 5. Approve — every child draft transitions via draftWorkflow.
    const approved = await svc.approveRecommendation({
      clientId: CLIENT_ID,
      recommendationId: recActive.recommendationId,
      userId: "auth0|alice",
    });
    expect(approved.status).toBe("success");
    expect(approveCalls.length).toBe(2);
    expect(scheduleCalls.length).toBe(0); // no scheduleAt → no schedule
    expect(prismaMock.state.recs.get(recActive.recommendationId).status).toBe(
      "APPROVED",
    );

    // 6. Non-negotiable: no draft was published anywhere along the
    //    chain. Recommendations only reached APPROVED — SCHEDULED
    //    requires an explicit scheduleAt.
    for (const d of prismaMock.state.drafts.values()) {
      expect(d.status).not.toBe("PUBLISHED");
    }
    for (const r of prismaMock.state.recs.values()) {
      expect(r.status).not.toBe("SCHEDULED");
    }
  });

  it("end-to-end with scheduleAt transitions rec to SCHEDULED and child drafts to SCHEDULED", async () => {
    const rec = await svc.upsertRecommendation({
      clientId: CLIENT_ID,
      triggerType: "NEW_LISTING",
      triggerObjectType: "listing",
      triggerObjectId: "listing-303",
      headline: "New listing — 303 Pine",
      whatWeNoticed: "Just added.",
      whyItMatters: "First 7 days.",
      recommendedChannels: ["FACEBOOK"],
      recommendedAngles: [],
      payloadJson: { propertyImageUrl: "https://example.com/p.jpg" },
    });
    await svc.generateDraftsForRecommendation({
      clientId: CLIENT_ID,
      recommendationId: rec.recommendationId,
      userId: "auth0|alice",
    });
    const when = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const out = await svc.approveRecommendation({
      clientId: CLIENT_ID,
      recommendationId: rec.recommendationId,
      userId: "auth0|alice",
      scheduleAt: when,
    });
    expect(out.status).toBe("success");
    expect(scheduleCalls.length).toBeGreaterThan(0);
    expect(prismaMock.state.recs.get(rec.recommendationId).status).toBe(
      "SCHEDULED",
    );
    // STILL no publish.
    for (const d of prismaMock.state.drafts.values()) {
      expect(d.status).not.toBe("PUBLISHED");
    }
  });
});
