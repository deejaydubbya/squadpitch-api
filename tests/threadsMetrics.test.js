// Threads metrics adapter tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../domains/studio/threads.constants.js", () => ({
  THREADS_GRAPH_BASE: "https://graph.test/v1.0",
}));

const { fetchThreadsMetrics } = await import(
  "../domains/studio/metricsSync/threads.metrics.js"
);

const TOKEN = "supersecret-threads-token-xyz";
const THREAD_ID = "thread_42";

let fetchMock;
const origFetch = global.fetch;
beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = origFetch;
});

const ok = (body) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });
const err = (status, body) =>
  Promise.resolve({ ok: false, status, json: async () => body });

describe("fetchThreadsMetrics", () => {
  it("normalizes views→impressions, replies→comments, and preserves reposts/quotes", async () => {
    fetchMock.mockReturnValueOnce(
      ok({
        data: [
          { name: "views", values: [{ value: 1234 }] },
          { name: "likes", values: [{ value: 50 }] },
          { name: "replies", values: [{ value: 7 }] },
          { name: "reposts", values: [{ value: 3 }] },
          { name: "quotes", values: [{ value: 2 }] },
          { name: "shares", values: [{ value: 1 }] },
        ],
      })
    );
    const r = await fetchThreadsMetrics({
      connection: { accessToken: TOKEN },
      externalPostId: THREAD_ID,
    });
    expect(r.raw).toMatchObject({
      impressions: 1234,
      likes: 50,
      comments: 7,
      reposts: 3,
      quotes: 2,
      shares: 1,
    });
  });

  it("returns null on 404 (post deleted / not yet indexed)", async () => {
    fetchMock.mockReturnValueOnce(err(404, {}));
    const r = await fetchThreadsMetrics({
      connection: { accessToken: TOKEN },
      externalPostId: THREAD_ID,
    });
    expect(r).toBeNull();
  });

  it("classifies 401 as AUTH_FAILED", async () => {
    fetchMock.mockReturnValueOnce(err(401, {}));
    await expect(
      fetchThreadsMetrics({
        connection: { accessToken: TOKEN },
        externalPostId: THREAD_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("classifies Meta permission code 10 as AUTH_FAILED, not transient", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, {
        error: { code: 10, message: "missing threads_manage_insights" },
      })
    );
    await expect(
      fetchThreadsMetrics({
        connection: { accessToken: TOKEN },
        externalPostId: THREAD_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("classifies 429 as transient", async () => {
    fetchMock.mockReturnValueOnce(err(429, {}));
    await expect(
      fetchThreadsMetrics({
        connection: { accessToken: TOKEN },
        externalPostId: THREAD_ID,
      })
    ).rejects.toMatchObject({ transient: true, status: 429 });
  });

  it("never includes the access token in thrown error messages", async () => {
    fetchMock.mockReturnValueOnce(
      err(500, { error: { message: `error with ${TOKEN}` } })
    );
    let caught;
    try {
      await fetchThreadsMetrics({
        connection: { accessToken: TOKEN },
        externalPostId: THREAD_ID,
      });
    } catch (e) {
      caught = e;
    }
    // Even though the body was echoed in the error, tokens should not
    // be present in the message field — Meta's error.message in our
    // tests doesn't actually include the token, but verify the
    // classification doesn't reach into the URL.
    expect(caught).toBeTruthy();
    expect(String(caught?.message ?? "")).not.toContain(TOKEN);
  });
});
