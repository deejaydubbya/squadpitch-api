// Instagram analytics ingestion — end-to-end (offline) verification.
//
// Drives the REAL metrics orchestrator (syncMetricsForDraft) through the
// REAL adapter registry and REAL Instagram adapter, with only global.fetch
// and the DB/token IO stubbed. Proves three things the audit called for:
//
//   1. A published Instagram post with a saved media id (externalPostId)
//      produces a stored PostMetrics row (channel=INSTAGRAM) → it will
//      appear in Analytics.
//   2. The insights refresh runs using ONLY Instagram endpoints — no
//      graph.facebook.com call is ever made (works without Facebook data).
//   3. Zero/empty Instagram insights still store a row (synced:true)
//      instead of being dropped as provider_no_metrics.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Capturing prisma mock ────────────────────────────────────────────
const draftStore = new Map();
let lastPostMetricsUpsert = null;

const prismaMock = {
  draft: { findUnique: vi.fn(async ({ where }) => draftStore.get(where.id) ?? null) },
  postMetrics: {
    findUnique: vi.fn(async () => null), // no prior sync → no cooldown
    upsert: vi.fn(async ({ create }) => {
      lastPostMetricsUpsert = create;
      return create;
    }),
  },
  rawMetric: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "raw1" })),
    update: vi.fn(async () => ({ id: "raw1" })),
  },
  normalizedMetric: {
    upsert: vi.fn(async ({ create }) => ({ id: "nm1", ...create, relativeEngagementRate: null })),
  },
  postInsight: { update: vi.fn(async () => null), upsert: vi.fn(async () => null) },
  postMetricSnapshot: { upsert: vi.fn(async () => null) },
};

const connectionMock = vi.fn();

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../domains/studio/connection.service.js", () => ({
  getConnectionForAdapter: (...a) => connectionMock(...a),
}));
vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: (conn) => conn,
}));
// Keep normalization realistic but DB-free: pass through the raw metric
// values the way the real INSTAGRAM rule does, without touching prisma /
// classification / timezone.
vi.mock("../domains/studio/normalization.service.js", () => ({
  normalizeRawMetrics: (_channel, raw) => ({
    impressions: raw.impressions ?? null,
    reach: raw.reach ?? null,
    engagements: (raw.likes ?? 0) + (raw.comments ?? 0) + (raw.saves ?? 0) + (raw.shares ?? 0),
    clicks: null,
    engagementRate: null,
  }),
  computeAndSaveInsight: async () => null,
}));
vi.mock("../domains/studio/performanceScoring.service.js", () => ({
  computePerformanceScore: () => ({ qualityScore: 60, observedScore: null, compositeScore: 60 }),
  getClientChannelBenchmarks: async () => ({}),
  getPostingConsistencyScore: async () => 0,
}));
vi.mock("../lib/queues.js", () => ({ getMetricsSyncQueue: () => null }));
vi.mock("../lib/timezone.js", () => ({ getClientTimezone: async () => "UTC" }));
vi.mock("../domains/studio/dataAnalytics.service.js", () => ({
  updatePerformanceForDraft: async () => null,
}));

const { syncMetricsForDraft } = await import("../domains/studio/metricsSyncService.js");

const IG_CONNECTION = {
  status: "CONNECTED",
  accessToken: "supersecret-ig-token",
  externalAccountId: "17841400000000000",
};

function seedIgDraft() {
  const draft = {
    id: "d-ig",
    clientId: "c1",
    channel: "INSTAGRAM",
    status: "PUBLISHED",
    externalPostId: "17895000000000000",
    publishedAt: new Date(),
    body: "New listing just hit the market",
    hooks: [],
    hashtags: ["#realestate"],
    cta: null,
    mediaUrl: "https://example.com/x.jpg",
    mediaType: "image",
  };
  draftStore.set(draft.id, draft);
  return draft;
}

beforeEach(() => {
  draftStore.clear();
  lastPostMetricsUpsert = null;
  vi.clearAllMocks();
  connectionMock.mockResolvedValue(IG_CONNECTION);
});

describe("Instagram analytics ingestion (end-to-end, offline)", () => {
  it("stores a PostMetrics row for a published IG post using only Instagram endpoints", async () => {
    seedIgDraft();
    const calledHosts = [];
    global.fetch = vi.fn(async (url) => {
      calledHosts.push(new URL(url).host);
      if (url.includes("/insights")) {
        // Tier 0 has `views`; simulate the account only supporting the
        // reduced set → code 100 then success (the real-world case).
        if (url.includes("views")) {
          return { status: 400, ok: false, json: async () => ({ error: { code: 100 } }) };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            data: [
              { name: "reach", values: [{ value: 900 }] },
              { name: "saved", values: [{ value: 12 }] },
              { name: "shares", values: [{ value: 4 }] },
            ],
          }),
        };
      }
      // fields
      return { status: 200, ok: true, json: async () => ({ like_count: 55, comments_count: 8 }) };
    });

    const result = await syncMetricsForDraft("d-ig");

    expect(result.synced).toBe(true);
    expect(prismaMock.postMetrics.upsert).toHaveBeenCalledTimes(1);
    expect(lastPostMetricsUpsert).toMatchObject({
      channel: "INSTAGRAM",
      reach: 900,
      saves: 12,
      shares: 4,
      likes: 55,
      comments: 8,
    });

    // Ran entirely against Instagram — never Facebook.
    expect(calledHosts.every((h) => h === "graph.instagram.com")).toBe(true);
    expect(calledHosts).not.toContain("graph.facebook.com");
  });

  it("still stores a row (synced) when Instagram insights are empty/zero", async () => {
    seedIgDraft();
    global.fetch = vi.fn(async (url) => {
      if (url.includes("/insights")) {
        return { status: 200, ok: true, json: async () => ({ data: [] }) };
      }
      return { status: 200, ok: true, json: async () => ({ like_count: 0, comments_count: 0 }) };
    });

    const result = await syncMetricsForDraft("d-ig");

    // The old adapter would have thrown → provider_transient → no row.
    expect(result.synced).toBe(true);
    expect(prismaMock.postMetrics.upsert).toHaveBeenCalledTimes(1);
    expect(lastPostMetricsUpsert).toMatchObject({
      channel: "INSTAGRAM",
      reach: 0,
      likes: 0,
      comments: 0,
    });
  });
});
