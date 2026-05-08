// metricsSyncService failure-mode tests.
//
// Exercises the reason-string contract callers depend on (the route
// handler at /drafts/:id/metrics/sync passes the result body straight
// through to the client; the worker logs reasons for ops). We stub
// every dependency that touches IO so the test runs in milliseconds.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mocks the test cases poke before invoking the service.
const draftStore = new Map();
const metricsStore = new Map();

const prismaMock = {
  draft: {
    findUnique: vi.fn(async ({ where }) => draftStore.get(where.id) ?? null),
  },
  postMetrics: {
    findUnique: vi.fn(async ({ where }) => metricsStore.get(where.draftId) ?? null),
    upsert: vi.fn(async () => null),
  },
  rawMetric: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => null),
    update: vi.fn(async () => null),
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
const fetchMetricsMock = vi.fn();
const adapterRegistryMock = vi.fn();

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../domains/studio/connection.service.js", () => ({
  getConnectionForAdapter: (...args) => connectionMock(...args),
}));
vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: (conn) => tokenRefreshMock(conn),
}));
vi.mock("../domains/studio/metricsSync/index.js", () => ({
  getMetricsAdapterForChannel: (...args) => adapterRegistryMock(...args),
}));
vi.mock("../domains/studio/normalization.service.js", () => ({
  normalizeRawMetrics: () => ({ impressions: 0, engagements: 0, engagementRate: 0 }),
  computeAndSaveInsight: async () => null,
}));
vi.mock("../domains/studio/performanceScoring.service.js", () => ({
  computePerformanceScore: () => ({ qualityScore: 50, observedScore: null, compositeScore: 50 }),
  getClientChannelBenchmarks: async () => ({}),
  getPostingConsistencyScore: async () => 0,
}));
vi.mock("../lib/queues.js", () => ({ getMetricsSyncQueue: () => null }));
vi.mock("../lib/timezone.js", () => ({ getClientTimezone: async () => "UTC" }));

const { syncMetricsForDraft } = await import(
  "../domains/studio/metricsSyncService.js"
);

beforeEach(() => {
  draftStore.clear();
  metricsStore.clear();
  vi.clearAllMocks();
});

function seedPublishedDraft(overrides = {}) {
  const draft = {
    id: "d1",
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

describe("syncMetricsForDraft — early exits", () => {
  it("returns draft_not_found for a missing draft", async () => {
    const r = await syncMetricsForDraft("nope");
    expect(r).toEqual({ synced: false, reason: "draft_not_found" });
  });

  it("returns not_published for an unpublished draft", async () => {
    seedPublishedDraft({ status: "DRAFT" });
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({ synced: false, reason: "not_published" });
  });

  it("returns no_external_id when externalPostId is null", async () => {
    seedPublishedDraft({ externalPostId: null });
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({ synced: false, reason: "no_external_id" });
  });
});

describe("syncMetricsForDraft — connection + token", () => {
  it("returns no_connection when adapter has no live connection", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce(null);
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({ synced: false, reason: "no_connection" });
  });

  it("returns no_connection when status is not CONNECTED", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce({ status: "ERROR", accessToken: "supersecret-bearer-xyz123" });
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({ synced: false, reason: "no_connection" });
  });

  it("returns token_refresh_failed with redacted detail when refresh throws", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockRejectedValueOnce(
      Object.assign(new Error("refresh token revoked"), { code: "REFRESH_REVOKED" })
    );
    const r = await syncMetricsForDraft("d1");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("token_refresh_failed");
    expect(r.detail).toBe("REFRESH_REVOKED");
    // critical: detail must NOT contain the access token
    expect(JSON.stringify(r)).not.toContain("supersecret");
  });
});

describe("syncMetricsForDraft — adapter dispatch", () => {
  it("returns unsupported_channel for an unknown channel", async () => {
    seedPublishedDraft({ channel: "MYSPACE" });
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    adapterRegistryMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("No adapter"), { code: "UNKNOWN_CHANNEL" });
    });
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({
      synced: false,
      reason: "unsupported_channel",
      detail: "MYSPACE",
    });
  });

  it("returns tiktok_video_id_missing when adapter throws TIKTOK_VIDEO_ID_MISSING", async () => {
    seedPublishedDraft({ channel: "TIKTOK", externalPostId: "v_pub_url~v2-1.123" });
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    adapterRegistryMock.mockReturnValueOnce(fetchMetricsMock);
    fetchMetricsMock.mockRejectedValueOnce(
      Object.assign(new Error("publish_id detected"), {
        code: "TIKTOK_VIDEO_ID_MISSING",
        channel: "TIKTOK",
      })
    );
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({ synced: false, reason: "tiktok_video_id_missing" });
  });

  it("returns provider_permission_denied for AUTH_FAILED", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    adapterRegistryMock.mockReturnValueOnce(fetchMetricsMock);
    fetchMetricsMock.mockRejectedValueOnce(
      Object.assign(new Error("ig auth"), { code: "AUTH_FAILED" })
    );
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({ synced: false, reason: "provider_permission_denied" });
  });

  it("returns provider_rate_limited for transient 429", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    adapterRegistryMock.mockReturnValueOnce(fetchMetricsMock);
    fetchMetricsMock.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { transient: true, status: 429 })
    );
    const r = await syncMetricsForDraft("d1");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("provider_rate_limited");
  });

  it("returns provider_transient for transient 5xx", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    adapterRegistryMock.mockReturnValueOnce(fetchMetricsMock);
    fetchMetricsMock.mockRejectedValueOnce(
      Object.assign(new Error("upstream 503"), { transient: true, status: 503 })
    );
    const r = await syncMetricsForDraft("d1");
    expect(r.reason).toBe("provider_transient");
  });

  it("returns provider_no_metrics when adapter returns null (post not found)", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    adapterRegistryMock.mockReturnValueOnce(fetchMetricsMock);
    fetchMetricsMock.mockResolvedValueOnce(null);
    const r = await syncMetricsForDraft("d1");
    expect(r).toEqual({ synced: false, reason: "provider_no_metrics" });
  });

  it("rethrows unclassified errors so the worker's permanent path catches them", async () => {
    seedPublishedDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: "supersecret-bearer-xyz123" });
    adapterRegistryMock.mockReturnValueOnce(fetchMetricsMock);
    fetchMetricsMock.mockRejectedValueOnce(new Error("unexpected explosion"));
    await expect(syncMetricsForDraft("d1")).rejects.toThrow(/unexpected explosion/);
  });
});

describe("TikTok publish_id heuristic", () => {
  // The heuristic is in tiktok.metrics.js — exercise it by importing
  // the adapter directly with a fake connection. We don't network.
  it("treats 'v_pub_url~v2-1.123' as a publish_id and throws TIKTOK_VIDEO_ID_MISSING", async () => {
    const { fetchTiktokMetrics } = await import(
      "../domains/studio/metricsSync/tiktok.metrics.js"
    );
    await expect(
      fetchTiktokMetrics({
        connection: { accessToken: "supersecret-bearer-xyz123" },
        externalPostId: "v_pub_url~v2-1.234567890",
      })
    ).rejects.toMatchObject({ code: "TIKTOK_VIDEO_ID_MISSING" });
  });

  it("does NOT throw for a numeric video_id", async () => {
    // This will try to fetch — stub global.fetch to short-circuit.
    const { fetchTiktokMetrics } = await import(
      "../domains/studio/metricsSync/tiktok.metrics.js"
    );
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      status: 404,
      json: async () => ({}),
    });
    try {
      const r = await fetchTiktokMetrics({
        connection: { accessToken: "supersecret-bearer-xyz123" },
        externalPostId: "7234567890123456789",
      });
      // 404 → adapter returns null. Critically, no TIKTOK_VIDEO_ID_MISSING throw.
      expect(r).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
