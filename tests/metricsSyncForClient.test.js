// syncMetricsForClient — workspace-scoped batch sync tests.
//
// Exercises the contract used by POST /api/v1/workspaces/:id/metrics/sync-meta
// (the admin/dev-gated Meta App Review trigger). Mocks the same IO
// surface as metricsSync.test.js so the internal call to
// syncMetricsForDraft runs the real classification logic.

import { describe, it, expect, vi, beforeEach } from "vitest";

const draftStore = new Map();
const findManyResults = []; // queue of arrays the next findMany call returns

const prismaMock = {
  draft: {
    findUnique: vi.fn(async ({ where }) => draftStore.get(where.id) ?? null),
    findMany: vi.fn(async ({ where }) => {
      // Filter the in-memory store by the same predicates the
      // production query uses, so cross-workspace isolation is
      // tested for real (not just trusted to the mock).
      const all = [...draftStore.values()];
      return all
        .filter((d) => d.clientId === where.clientId)
        .filter((d) => d.status === "PUBLISHED")
        .filter((d) => d.externalPostId != null)
        .filter((d) =>
          where.channel?.in ? where.channel.in.includes(d.channel) : true
        )
        .map((d) => ({ id: d.id, channel: d.channel }));
    }),
  },
  postMetrics: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => null),
  },
  rawMetric: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "rm1" })),
    update: vi.fn(async () => ({ id: "rm1" })),
  },
  normalizedMetric: {
    upsert: vi.fn(async () => ({ id: "nm1", relativeEngagementRate: null })),
  },
  postInsight: {
    update: vi.fn(async () => null),
  },
  postMetricSnapshot: {
    upsert: vi.fn(async () => null),
  },
};

const connectionMock = vi.fn();
const tokenRefreshMock = vi.fn();
const adapterRegistryMock = vi.fn();
const fetchMetricsByChannel = new Map(); // channel → fn(draftId) → result|throw

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../domains/studio/connection.service.js", () => ({
  getConnectionForAdapter: (...args) => connectionMock(...args),
}));
vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: (conn) => tokenRefreshMock(conn),
}));
vi.mock("../domains/studio/metricsSync/index.js", () => ({
  getMetricsAdapterForChannel: (channel) => {
    const fn = fetchMetricsByChannel.get(channel);
    if (!fn) throw Object.assign(new Error("No adapter"), { code: "UNKNOWN_CHANNEL" });
    return fn;
  },
}));
vi.mock("../domains/studio/normalization.service.js", () => ({
  normalizeRawMetrics: () => ({ impressions: 100, engagements: 10, engagementRate: 0.1 }),
  computeAndSaveInsight: async () => null,
}));
vi.mock("../domains/studio/performanceScoring.service.js", () => ({
  computePerformanceScore: () => ({ qualityScore: 50, observedScore: 50, compositeScore: 50 }),
  getClientChannelBenchmarks: async () => ({}),
  getPostingConsistencyScore: async () => 0,
}));
vi.mock("../lib/queues.js", () => ({ getMetricsSyncQueue: () => null }));
vi.mock("../lib/timezone.js", () => ({ getClientTimezone: async () => "UTC" }));
vi.mock("../domains/studio/dataAnalytics.service.js", () => ({
  updatePerformanceForDraft: async () => null,
}));

const { syncMetricsForClient } = await import(
  "../domains/studio/metricsSyncService.js"
);

beforeEach(() => {
  draftStore.clear();
  findManyResults.length = 0;
  fetchMetricsByChannel.clear();
  vi.clearAllMocks();

  // Sensible defaults — every test that needs a connection gets one.
  connectionMock.mockResolvedValue({
    status: "CONNECTED",
    accessToken: "supersecret-bearer-xyz123",
    clientId: "c1",
    channel: "INSTAGRAM",
  });
  tokenRefreshMock.mockImplementation(async (c) => c);
});

function seedDraft(overrides = {}) {
  const draft = {
    id: overrides.id ?? `d${draftStore.size + 1}`,
    clientId: "c1",
    channel: "INSTAGRAM",
    status: "PUBLISHED",
    externalPostId: "ig-123",
    publishedAt: new Date(),
    body: "",
    hooks: [],
    hashtags: [],
    cta: null,
    mediaUrl: null,
    mediaType: null,
    ...overrides,
  };
  draftStore.set(draft.id, draft);
  return draft;
}

function setSuccessAdapter(channel) {
  fetchMetricsByChannel.set(channel, async () => ({
    raw: { impressions: 100, reach: 80, likes: 5, comments: 1, saves: 0, shares: 0 },
    fetchedAt: new Date(),
  }));
}

describe("syncMetricsForClient — empty workspace", () => {
  it("returns zero counts when there are no published Meta drafts", async () => {
    const r = await syncMetricsForClient("c1");
    expect(r).toEqual({
      totalCandidates: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    });
  });

  it("ignores non-Meta channels", async () => {
    seedDraft({ id: "d-yt", channel: "YOUTUBE" });
    seedDraft({ id: "d-x", channel: "X" });
    const r = await syncMetricsForClient("c1");
    expect(r.totalCandidates).toBe(0);
  });
});

describe("syncMetricsForClient — happy path", () => {
  it("syncs every eligible FB + IG draft", async () => {
    seedDraft({ id: "d-ig-1", channel: "INSTAGRAM" });
    seedDraft({ id: "d-ig-2", channel: "INSTAGRAM" });
    seedDraft({ id: "d-fb-1", channel: "FACEBOOK" });
    setSuccessAdapter("INSTAGRAM");
    setSuccessAdapter("FACEBOOK");

    const r = await syncMetricsForClient("c1");
    expect(r.totalCandidates).toBe(3);
    expect(r.synced).toBe(3);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.errors).toEqual([]);
  });
});

describe("syncMetricsForClient — partial failure", () => {
  it("continues after a permission_denied; reports it as failed", async () => {
    seedDraft({ id: "d1", channel: "INSTAGRAM" });
    seedDraft({ id: "d2", channel: "INSTAGRAM" });
    seedDraft({ id: "d3", channel: "INSTAGRAM" });

    let call = 0;
    fetchMetricsByChannel.set("INSTAGRAM", async () => {
      call += 1;
      if (call === 2) {
        throw Object.assign(new Error("ig auth"), { code: "AUTH_FAILED" });
      }
      return {
        raw: { impressions: 100, reach: 80, likes: 5, comments: 1, saves: 0, shares: 0 },
        fetchedAt: new Date(),
      };
    });

    const r = await syncMetricsForClient("c1");
    expect(r.totalCandidates).toBe(3);
    expect(r.synced).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      channel: "INSTAGRAM",
      reason: "provider_permission_denied",
    });
  });

  it("classifies no_connection as skipped, not failed", async () => {
    seedDraft({ id: "d1", channel: "INSTAGRAM" });
    seedDraft({ id: "d2", channel: "INSTAGRAM" });
    setSuccessAdapter("INSTAGRAM");

    let call = 0;
    connectionMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) return null; // first draft: no connection
      return {
        status: "CONNECTED",
        accessToken: "supersecret-bearer-xyz123",
        clientId: "c1",
        channel: "INSTAGRAM",
      };
    });

    const r = await syncMetricsForClient("c1");
    expect(r.synced).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.errors[0]).toMatchObject({
      reason: "no_connection",
    });
  });
});

describe("syncMetricsForClient — cross-workspace isolation", () => {
  it("never touches another workspace's drafts", async () => {
    seedDraft({ id: "d-mine", clientId: "c1", channel: "INSTAGRAM" });
    seedDraft({ id: "d-theirs", clientId: "c2", channel: "INSTAGRAM" });
    setSuccessAdapter("INSTAGRAM");

    const r = await syncMetricsForClient("c1");
    expect(r.totalCandidates).toBe(1);
    expect(r.synced).toBe(1);

    // The findMany predicate must include clientId — verify the mock
    // received it (cross-tenant isolation is the most security-load-
    // bearing assertion in this file).
    const call = prismaMock.draft.findMany.mock.calls.at(-1)[0];
    expect(call.where.clientId).toBe("c1");
  });
});

describe("syncMetricsForClient — token redaction", () => {
  it("never returns access tokens in error details", async () => {
    seedDraft({ id: "d1", channel: "INSTAGRAM" });
    tokenRefreshMock.mockRejectedValueOnce(
      Object.assign(new Error("token failure with supersecret-bearer-xyz123"), {
        code: "REFRESH_REVOKED",
      })
    );

    const r = await syncMetricsForClient("c1");
    expect(JSON.stringify(r)).not.toContain("supersecret");
  });
});
