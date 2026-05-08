// fetchFacebookMetrics() tests.
//
// Covers:
//   - happy path with the full metric set
//   - reaction-types object summing
//   - Meta error code 100 → fallback to minimal set + partial=true
//   - minimal set also rejected → null (provider_no_metrics)
//   - 401/403 → AUTH_FAILED
//   - 429 → transient
//   - 500 → transient
//
// We never call real Meta — the global `fetch` is stubbed per test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../domains/studio/meta.constants.js", () => ({
  META_GRAPH_BASE: "https://graph.test/v20.0",
}));

const { fetchFacebookMetrics } = await import(
  "../domains/studio/metricsSync/facebook.metrics.js"
);

const SECRET = "supersecret-bearer-xyz123";
const POST_ID = "12345_67890";

let fetchMock;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function ok(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}
function err(status, body = {}) {
  return Promise.resolve({ ok: false, status, json: async () => body });
}

describe("fetchFacebookMetrics — happy path", () => {
  it("requests the safe metric set and returns the normalized raw shape", async () => {
    fetchMock
      // 1st: insights call
      .mockReturnValueOnce(
        ok({
          data: [
            { name: "post_impressions", values: [{ value: 1234 }] },
            { name: "post_impressions_unique", values: [{ value: 1100 }] },
            {
              name: "post_reactions_by_type_total",
              values: [{ value: { like: 50, love: 5, haha: 2 } }],
            },
            { name: "post_clicks", values: [{ value: 99 }] },
          ],
        })
      )
      // 2nd: post object call (comments + shares)
      .mockReturnValueOnce(
        ok({
          comments: { summary: { total_count: 12 } },
          shares: { count: 3 },
        })
      );

    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID,
    });

    expect(r.raw).toEqual({
      impressions: 1234,
      reach: 1100,
      reactions: 57,
      comments: 12,
      shares: 3,
      clicks: 99,
    });
    expect(r.fetchedAt).toBeInstanceOf(Date);

    // The insights URL must contain post_impressions_unique (NOT post_reach).
    // (Meta's API expects the access_token in the querystring — that's
    // by design and not something we can avoid.)
    const insightsUrl = fetchMock.mock.calls[0][0];
    expect(insightsUrl).toContain("post_impressions");
    expect(insightsUrl).toContain("post_impressions_unique");
    expect(insightsUrl).not.toContain("post_reach");
  });

  it("sums all reaction types (object-shaped post_reactions_by_type_total)", async () => {
    fetchMock
      .mockReturnValueOnce(
        ok({
          data: [
            { name: "post_impressions", values: [{ value: 100 }] },
            { name: "post_impressions_unique", values: [{ value: 80 }] },
            {
              name: "post_reactions_by_type_total",
              values: [
                {
                  value: {
                    like: 10,
                    love: 4,
                    wow: 2,
                    haha: 1,
                    sad: 0,
                    angry: 1,
                    care: 3,
                  },
                },
              ],
            },
            { name: "post_clicks", values: [{ value: 0 }] },
          ],
        })
      )
      .mockReturnValueOnce(ok({ comments: { summary: { total_count: 0 } }, shares: null }));

    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID,
    });
    expect(r.raw.reactions).toBe(21);
    expect(r.raw.shares).toBe(0); // shares missing → 0
  });

  it("handles a numeric (not object) reactions value defensively", async () => {
    fetchMock
      .mockReturnValueOnce(
        ok({
          data: [
            { name: "post_impressions", values: [{ value: 50 }] },
            { name: "post_impressions_unique", values: [{ value: 50 }] },
            { name: "post_reactions_by_type_total", values: [{ value: 7 }] },
            { name: "post_clicks", values: [{ value: 1 }] },
          ],
        })
      )
      .mockReturnValueOnce(ok({ comments: { summary: { total_count: 0 } } }));
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID,
    });
    expect(r.raw.reactions).toBe(7);
  });
});

describe("fetchFacebookMetrics — invalid-metric fallback (Meta error 100)", () => {
  it("retries with the minimal metric set and returns partial metrics", async () => {
    fetchMock
      // 1st: full set rejected with code 100
      .mockReturnValueOnce(
        err(400, {
          error: {
            code: 100,
            message: "(#100) The value must be a valid insights metric",
          },
        })
      )
      // 2nd: minimal set succeeds (no reactions / clicks because they
      // weren't requested — those will land as 0)
      .mockReturnValueOnce(
        ok({
          data: [
            { name: "post_impressions", values: [{ value: 500 }] },
            { name: "post_impressions_unique", values: [{ value: 400 }] },
          ],
        })
      )
      // 3rd: post object
      .mockReturnValueOnce(
        ok({
          comments: { summary: { total_count: 5 } },
          shares: { count: 1 },
        })
      );

    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID,
    });

    expect(r).not.toBeNull();
    expect(r.raw).toMatchObject({
      impressions: 500,
      reach: 400,
      reactions: 0, // not requested in minimal set
      clicks: 0,
      comments: 5,
      shares: 1,
      _partial: true,
    });
    expect(typeof r.raw._partialReason).toBe("string");
    // Three fetch calls total: full insights (failed), minimal insights, post object.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("if the minimal set ALSO returns code 100, returns null (no_metrics) — does NOT throw transient", async () => {
    fetchMock
      .mockReturnValueOnce(
        err(400, { error: { code: 100, message: "invalid metric" } })
      )
      .mockReturnValueOnce(
        err(400, { error: { code: 100, message: "still invalid" } })
      );
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID,
    });
    expect(r).toBeNull();
  });
});

describe("fetchFacebookMetrics — error classification", () => {
  it("404 → null (post not found)", async () => {
    fetchMock.mockReturnValueOnce(err(404, { error: { code: 803 } }));
    const r = await fetchFacebookMetrics({
      connection: { accessToken: SECRET },
      externalPostId: POST_ID,
    });
    expect(r).toBeNull();
  });

  it("401 → AUTH_FAILED (no token leaked)", async () => {
    fetchMock.mockReturnValueOnce(err(401, { error: { message: "auth fail" } }));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("403 → AUTH_FAILED", async () => {
    fetchMock.mockReturnValueOnce(err(403, {}));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("429 → transient with status set", async () => {
    fetchMock.mockReturnValueOnce(err(429, {}));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID,
      })
    ).rejects.toMatchObject({ transient: true, status: 429 });
  });

  it("500 → transient", async () => {
    fetchMock.mockReturnValueOnce(err(500, {}));
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID,
      })
    ).rejects.toMatchObject({ transient: true, status: 500 });
  });

  it("Token never appears in thrown error messages", async () => {
    fetchMock.mockReturnValueOnce(
      err(401, { error: { message: "auth fail" } })
    );
    let caught;
    try {
      await fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught.message).not.toContain(SECRET);
  });

  it("non-100 4xx throws transient (so the worker sees a generic upstream error, not a silent skip)", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, { error: { code: 200, message: "permissions issue" } })
    );
    await expect(
      fetchFacebookMetrics({
        connection: { accessToken: SECRET },
        externalPostId: POST_ID,
      })
    ).rejects.toMatchObject({ transient: true });
  });
});
