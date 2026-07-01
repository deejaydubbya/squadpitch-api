// Instagram metrics adapter tests.
//
// These lock in the fix for the "published Instagram posts never appear
// in Analytics" bug: the adapter used to issue a single all-or-nothing
// insights request (impressions,reach,saved,shares) and THROW on Meta
// error code 100, so no metric row was ever written. The adapter now
// mirrors the Facebook adapter — metric ladder + partial success + a
// row is still returned when insights are zero/empty/unavailable.
//
// Everything is offline: we stub global.fetch and route by URL. No
// Facebook endpoints are touched — this proves the Instagram insights
// path runs independently of any Facebook data.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchInstagramMetrics } from "../domains/studio/metricsSync/instagram.metrics.js";

const CONNECTION = {
  accessToken: "supersecret-ig-token-xyz",
  externalAccountId: "17841400000000000", // IG professional account id
};
const MEDIA_ID = "17895000000000000";

// Build a fetch mock that routes by URL. `insights` handles the
// /{media}/insights calls (the metric ladder), `fields` handles the
// /{media}?fields=… object read. Each handler returns { status, body }.
function mockFetch({ insights, fields }) {
  return vi.fn(async (url) => {
    const isInsights = url.includes("/insights");
    const { status = 200, body = {} } = (isInsights ? insights : fields)(url);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  });
}

// Convenience: a well-formed IG insights payload from an array of
// [name, value] pairs.
function insightsData(pairs) {
  return { data: pairs.map(([name, value]) => ({ name, values: [{ value }] })) };
}

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchInstagramMetrics — metric ladder", () => {
  it("steps down past a code-100 rejection and still returns a row", async () => {
    // Tier 0 (includes `views`) is rejected with code 100; the next tier
    // without `views` succeeds — exactly the deprecated-`impressions`/
    // unsupported-metric situation that used to drop the post entirely.
    global.fetch = mockFetch({
      insights: (url) =>
        url.includes("views")
          ? { status: 400, body: { error: { code: 100, message: "views is not supported" } } }
          : { status: 200, body: insightsData([["reach", 1234], ["saved", 5], ["shares", 2]]) },
      fields: () => ({ status: 200, body: { like_count: 10, comments_count: 3 } }),
    });

    const result = await fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID });

    expect(result).not.toBeNull();
    expect(result.raw).toMatchObject({
      reach: 1234,
      saves: 5,
      shares: 2,
      likes: 10,
      comments: 3,
    });
    // Insights ultimately succeeded → not flagged partial.
    expect(result.raw._partial).toBeUndefined();
  });

  it("falls back to likes/comments when EVERY insight tier is rejected (code 100)", async () => {
    global.fetch = mockFetch({
      insights: () => ({ status: 400, body: { error: { code: 100, message: "unsupported" } } }),
      fields: () => ({ status: 200, body: { like_count: 7, comments_count: 1 } }),
    });

    const result = await fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID });

    expect(result).not.toBeNull();
    expect(result.raw.reach).toBe(0);
    expect(result.raw.likes).toBe(7);
    expect(result.raw.comments).toBe(1);
    expect(result.raw._partial).toBe(true);
    expect(result.raw._partialReasons).toContain("insights_unavailable:invalid_metric");
  });
});

describe("fetchInstagramMetrics — zero/empty insights stay visible", () => {
  it("returns a zero-filled row (NOT null) when insights are empty", async () => {
    // A fresh post: insights 200 but empty data array. Must still yield a
    // row so the post shows in Analytics instead of being hidden.
    global.fetch = mockFetch({
      insights: () => ({ status: 200, body: { data: [] } }),
      fields: () => ({ status: 200, body: { like_count: 0, comments_count: 0 } }),
    });

    const result = await fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID });

    expect(result).not.toBeNull();
    expect(result.raw).toMatchObject({ reach: 0, likes: 0, comments: 0, saves: 0, shares: 0 });
    expect(result.raw._partialReasons).toContain("insights_empty");
  });

  it("returns a row when all insight values are literally zero", async () => {
    global.fetch = mockFetch({
      insights: () => ({ status: 200, body: insightsData([["reach", 0], ["saved", 0], ["shares", 0]]) }),
      fields: () => ({ status: 200, body: { like_count: 0, comments_count: 0 } }),
    });

    const result = await fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID });

    expect(result).not.toBeNull();
    expect(result.raw.reach).toBe(0);
  });

  it("maps `views` into the impressions column (IG deprecated impressions)", async () => {
    global.fetch = mockFetch({
      insights: () => ({ status: 200, body: insightsData([["reach", 100], ["views", 250]]) }),
      fields: () => ({ status: 200, body: { like_count: 4, comments_count: 0 } }),
    });

    const result = await fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID });

    expect(result.raw.impressions).toBe(250);
    expect(result.raw.views).toBe(250);
  });
});

describe("fetchInstagramMetrics — error handling", () => {
  it("returns null when the media is gone (404)", async () => {
    global.fetch = mockFetch({
      insights: () => ({ status: 404, body: {} }),
      fields: () => ({ status: 404, body: {} }),
    });

    const result = await fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID });
    expect(result).toBeNull();
  });

  it("throws AUTH_FAILED on 401 (no token leaked)", async () => {
    global.fetch = mockFetch({
      insights: () => ({ status: 401, body: { error: { message: "bad token" } } }),
      fields: () => ({ status: 200, body: {} }),
    });

    await expect(
      fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("throws AUTH_FAILED on a Meta permission code (e.g. 10)", async () => {
    global.fetch = mockFetch({
      insights: () => ({
        status: 400,
        body: { error: { code: 10, message: "missing instagram_business_manage_insights" } },
      }),
      fields: () => ({ status: 200, body: {} }),
    });

    await expect(
      fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("throws transient on 5xx so the sync retries", async () => {
    global.fetch = mockFetch({
      insights: () => ({ status: 503, body: {} }),
      fields: () => ({ status: 200, body: {} }),
    });

    await expect(
      fetchInstagramMetrics({ connection: CONNECTION, externalPostId: MEDIA_ID })
    ).rejects.toMatchObject({ transient: true, status: 503 });
  });

  it("never includes the access token in the thrown error", async () => {
    global.fetch = mockFetch({
      insights: () => ({ status: 401, body: { error: { message: "bad token" } } }),
      fields: () => ({ status: 200, body: {} }),
    });

    const err = await fetchInstagramMetrics({
      connection: CONNECTION,
      externalPostId: MEDIA_ID,
    }).catch((e) => e);
    expect(JSON.stringify({ msg: err.message, ...err })).not.toContain("supersecret");
  });
});
