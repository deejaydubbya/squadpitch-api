// fetchFacebookMetrics() — partial-success behavior.
//
// The adapter fetches insights and post-object engagement
// independently. Either alone is success; only "both empty" returns
// null (→ provider_no_metrics).
//
// Test calls fetch() in this order:
//   1. /{postId}/insights?metric=full_set
//   2. /{postId}/insights?metric=minimal_set                (only on code 100)
//   3. /{postId}?fields=reactions.limit(0).summary(true)…
//   4. /{postId}?fields=likes.limit(0).summary(true)…       (only on reactions miss)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../domains/studio/meta.constants.js", () => ({
  META_GRAPH_BASE: "https://graph.test/v20.0",
}));

const { fetchFacebookMetrics } = await import(
  "../domains/studio/metricsSync/facebook.metrics.js"
);

const SECRET = "supersecret-bearer-xyz123";
const POST_ID_COMPOSITE = "12345_67890";
const POST_ID_SIMPLE = "67890";

let fetchMock;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const err = (status, body = {}) =>
  Promise.resolve({ ok: false, status, json: async () => body });

const insightsFull = (impressions, reach, reactions, clicks) => ({
  data: [
    { name: "post_impressions", values: [{ value: impressions }] },
    { name: "post_impressions_unique", values: [{ value: reach }] },
    { name: "post_reactions_by_type_total", values: [{ value: reactions }] },
    { name: "post_clicks", values: [{ value: clicks }] },
  ],
});

const reactionsObject = (n) => ({
  reactions: { data: [], summary: { total_count: n } },
  comments: { data: [], summary: { total_count: 0 } },
  shares: { count: 0 },
});

describe("fetchFacebookMetrics — full success", () => {
  it("returns full insights + engagement (no _partial flag)", async () => {
    fetchMock
      .mockReturnValueOnce(
        ok(insightsFull(1000, 800, { like: 40, love: 5, haha: 5 }, 12))
      )
      .mockReturnValueOnce(
        ok({
          reactions: { summary: { total_count: 50 } },
          comments: { summary: { total_count: 7 } },
          shares: { count: 3 },
          permalink_url: "https://facebook.com/foo",
        })
      );

    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });

    expect(r.raw).toEqual({
      impressions: 1000,
      reach: 800,
      clicks: 12,
      // engagement reactions take priority over insights-summed reactions
      reactions: 50,
      comments: 7,
      shares: 3,
    });
    expect(r.raw._partial).toBeUndefined();
    expect(r.raw._partialReasons).toBeUndefined();

    // Insights URL must request the right metrics (not post_reach).
    expect(fetchMock.mock.calls[0][0]).toContain("post_impressions_unique");
    expect(fetchMock.mock.calls[0][0]).not.toContain("post_reach");
    // Post-object URL requests reactions+comments+shares+permalink_url.
    const postUrl = fetchMock.mock.calls[1][0];
    expect(postUrl).toMatch(/reactions/);
    expect(postUrl).toMatch(/comments/);
    expect(postUrl).toMatch(/shares/);
    expect(postUrl).toMatch(/permalink_url/);
  });
});

describe("fetchFacebookMetrics — partial: insights empty but engagement available", () => {
  it("returns engagement counts with _partial flag (fresh-post lag scenario)", async () => {
    // Insights endpoint returns 200 OK but data: [] — no metrics yet.
    fetchMock
      .mockReturnValueOnce(ok({ data: [] }))
      .mockReturnValueOnce(
        ok({
          reactions: { summary: { total_count: 12 } },
          comments: { summary: { total_count: 2 } },
          shares: { count: 1 },
        })
      );

    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });

    expect(r).not.toBeNull();
    expect(r.raw.impressions).toBe(0);
    expect(r.raw.reach).toBe(0);
    expect(r.raw.clicks).toBe(0);
    expect(r.raw.reactions).toBe(12);
    expect(r.raw.comments).toBe(2);
    expect(r.raw.shares).toBe(1);
    expect(r.raw._partial).toBe(true);
    expect(r.raw._partialReasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/^facebook_insights_unavailable:/)])
    );
  });
});

describe("fetchFacebookMetrics — partial: invalid metric but engagement available", () => {
  it("returns engagement after Meta error 100 from BOTH full + minimal sets", async () => {
    fetchMock
      // 1st: full set 400 + code 100
      .mockReturnValueOnce(err(400, { error: { code: 100, message: "invalid metric" } }))
      // 2nd: minimal set ALSO 400 + code 100
      .mockReturnValueOnce(err(400, { error: { code: 100, message: "still invalid" } }))
      // 3rd: post object engagement available
      .mockReturnValueOnce(
        ok({
          reactions: { summary: { total_count: 9 } },
          comments: { summary: { total_count: 4 } },
          shares: { count: 2 },
        })
      );

    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    expect(r).not.toBeNull();
    expect(r.raw.reactions).toBe(9);
    expect(r.raw._partial).toBe(true);
    expect(r.raw._partialReasons[0]).toContain("invalid_metric");
  });
});

describe("fetchFacebookMetrics — reactions unavailable, likes summary works", () => {
  it("falls back to likes.summary.total_count", async () => {
    fetchMock
      .mockReturnValueOnce(ok(insightsFull(500, 400, 0, 5)))
      // First post-object call — reactions field rejected (e.g. 400 / missing)
      .mockReturnValueOnce(
        err(400, { error: { code: 100, message: "Unsupported field reactions" } })
      )
      // Retry with likes
      .mockReturnValueOnce(
        ok({
          likes: { summary: { total_count: 33 } },
          comments: { summary: { total_count: 1 } },
          shares: { count: 0 },
        })
      );

    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    expect(r).not.toBeNull();
    expect(r.raw.reactions).toBe(33);
    expect(r.raw._partial).toBe(true);
    expect(r.raw._partialReasons).toContain("reactions_fallback_to_likes");
  });

  it("also falls back when reactions field is simply missing from the response (200 OK, no field)", async () => {
    fetchMock
      .mockReturnValueOnce(ok(insightsFull(500, 400, 0, 5)))
      // 200 OK but no `reactions` key — older app permissions tier
      .mockReturnValueOnce(
        ok({
          comments: { summary: { total_count: 0 } },
          shares: { count: 0 },
        })
      )
      .mockReturnValueOnce(
        ok({
          likes: { summary: { total_count: 7 } },
          comments: { summary: { total_count: 0 } },
          shares: { count: 0 },
        })
      );
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    expect(r.raw.reactions).toBe(7);
    expect(r.raw._partialReasons).toContain("reactions_fallback_to_likes");
  });
});

describe("fetchFacebookMetrics — both insights and engagement empty", () => {
  it("returns null (→ provider_no_metrics)", async () => {
    fetchMock
      // Insights empty
      .mockReturnValueOnce(ok({ data: [] }))
      // First post object: response has no engagement fields at all
      .mockReturnValueOnce(ok({}))
      // Likes fallback also returns nothing useful
      .mockReturnValueOnce(ok({}));
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    expect(r).toBeNull();
  });

  it("404 from insights returns null without making the post-object call", async () => {
    fetchMock.mockReturnValueOnce(err(404, { error: { code: 803 } }));
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    expect(r).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("404 from post-object returns null too", async () => {
    fetchMock
      .mockReturnValueOnce(ok({ data: [] }))
      .mockReturnValueOnce(err(404, {}));
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    expect(r).toBeNull();
  });
});

describe("fetchFacebookMetrics — error classification", () => {
  it("401 → AUTH_FAILED, no fallback attempted", async () => {
    fetchMock.mockReturnValueOnce(err(401, {}));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID_COMPOSITE,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    // Critical: we don't try the post-object call when auth fails on insights.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("403 on post-object after successful insights → AUTH_FAILED", async () => {
    fetchMock
      .mockReturnValueOnce(ok(insightsFull(100, 80, 0, 0)))
      .mockReturnValueOnce(err(403, {}));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID_COMPOSITE,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("429 → transient", async () => {
    fetchMock.mockReturnValueOnce(err(429, {}));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID_COMPOSITE,
      })
    ).rejects.toMatchObject({ transient: true, status: 429 });
  });

  it("500 on insights → transient (no engagement attempt)", async () => {
    fetchMock.mockReturnValueOnce(err(500, {}));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID_COMPOSITE,
      })
    ).rejects.toMatchObject({ transient: true, status: 500 });
  });

  it("non-100 4xx on insights — degrades to engagement-only success", async () => {
    fetchMock
      .mockReturnValueOnce(err(400, { error: { code: 200, message: "permissions" } }))
      .mockReturnValueOnce(
        ok({
          reactions: { summary: { total_count: 1 } },
          comments: { summary: { total_count: 0 } },
          shares: { count: 0 },
        })
      );
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    // Spec: insights-unavailable but engagement-available is partial success.
    expect(r).not.toBeNull();
    expect(r.raw.reactions).toBe(1);
    expect(r.raw._partial).toBe(true);
  });

  it("Token never appears in thrown error messages", async () => {
    fetchMock.mockReturnValueOnce(err(401, {}));
    let caught;
    try {
      await fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID_COMPOSITE,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught.message).not.toContain(SECRET);
  });
});

describe("fetchFacebookMetrics — externalPostId shape logging", () => {
  it("logs composite shape for page_post composite ids", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock
      .mockReturnValueOnce(ok({ data: [] }))
      .mockReturnValueOnce(
        ok({
          reactions: { summary: { total_count: 0 } },
          comments: { summary: { total_count: 0 } },
          shares: { count: 0 },
        })
      );
    await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_COMPOSITE,
    });
    const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("composite_page_post");
    // Make sure the token is NEVER in the logs.
    expect(logged).not.toContain(SECRET);
    logSpy.mockRestore();
  });

  it("logs simple shape for non-composite ids", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock
      .mockReturnValueOnce(ok({ data: [] }))
      .mockReturnValueOnce(
        ok({
          reactions: { summary: { total_count: 0 } },
          comments: { summary: { total_count: 0 } },
          shares: { count: 0 },
        })
      );
    await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID_SIMPLE,
    });
    const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("shape=simple");
    logSpy.mockRestore();
  });
});
