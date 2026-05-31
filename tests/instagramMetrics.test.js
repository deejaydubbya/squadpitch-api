// fetchInstagramMetrics() tests.
//
// Covers:
//   - happy path
//   - 404 → null
//   - 401/403 → AUTH_FAILED
//   - Meta permission codes 10/200/230/250 → AUTH_FAILED (was provider_transient)
//   - 429 / 5xx → transient
//   - other 4xx → transient
//   - Token never appears in error messages.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../domains/studio/meta.constants.js", () => ({
  INSTAGRAM_GRAPH_BASE: "https://graph.test/v20.0",
}));

const { fetchInstagramMetrics } = await import(
  "../domains/studio/metricsSync/instagram.metrics.js"
);

const SECRET = "supersecret-bearer-xyz123";
const MEDIA_ID = "17841401616527259_1234567890";

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

describe("fetchInstagramMetrics — happy path", () => {
  it("returns flat raw payload", async () => {
    fetchMock
      .mockReturnValueOnce(
        ok({
          data: [
            { name: "impressions", values: [{ value: 1000 }] },
            { name: "reach", values: [{ value: 800 }] },
            { name: "saved", values: [{ value: 25 }] },
            { name: "shares", values: [{ value: 5 }] },
          ],
        })
      )
      .mockReturnValueOnce(ok({ like_count: 50, comments_count: 6 }));

    const r = await fetchInstagramMetrics({
      connection: { accessToken: SECRET },
      externalPostId: MEDIA_ID,
    });

    expect(r.raw).toEqual({
      impressions: 1000,
      reach: 800,
      likes: 50,
      comments: 6,
      saves: 25,
      shares: 5,
    });
  });
});

describe("fetchInstagramMetrics — error classification", () => {
  it("404 → null", async () => {
    fetchMock.mockReturnValueOnce(err(404, {}));
    const r = await fetchInstagramMetrics({
      connection: { accessToken: SECRET },
      externalPostId: MEDIA_ID,
    });
    expect(r).toBeNull();
  });

  it("401 → AUTH_FAILED", async () => {
    fetchMock.mockReturnValueOnce(err(401, {}));
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("403 → AUTH_FAILED", async () => {
    fetchMock.mockReturnValueOnce(err(403, {}));
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("Meta error code 10 (Application does not have permission) → AUTH_FAILED, not transient", async () => {
    // This is the bug spinstr363 reported: missing instagram_manage_insights
    // surfaced as provider_transient. Now classified as permission_denied.
    fetchMock.mockReturnValueOnce(
      err(400, {
        error: {
          code: 10,
          message: "(#10) Application does not have permission for this action",
        },
      })
    );
    let caught;
    try {
      await fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe("AUTH_FAILED");
    expect(caught.transient).toBeUndefined();
  });

  it("Meta error code 200 (Permissions error) → AUTH_FAILED", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, { error: { code: 200, message: "Permissions error" } })
    );
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("Meta error code 230 → AUTH_FAILED", async () => {
    fetchMock.mockReturnValueOnce(err(400, { error: { code: 230 } }));
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("Meta error code 250 → AUTH_FAILED", async () => {
    fetchMock.mockReturnValueOnce(err(400, { error: { code: 250 } }));
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("429 → transient", async () => {
    fetchMock.mockReturnValueOnce(err(429, {}));
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ transient: true, status: 429 });
  });

  it("500 → transient", async () => {
    fetchMock.mockReturnValueOnce(err(500, {}));
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ transient: true, status: 500 });
  });

  it("non-permission 4xx (e.g. code 100 invalid metric) still throws transient", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, { error: { code: 100, message: "invalid metric" } })
    );
    await expect(
      fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      })
    ).rejects.toMatchObject({ transient: true });
  });

  it("Token never appears in thrown error messages (even when Meta echoes user_id etc.)", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, {
        error: { code: 10, message: "Application does not have permission for this action" },
      })
    );
    let caught;
    try {
      await fetchInstagramMetrics({
        connection: { accessToken: SECRET },
        externalPostId: MEDIA_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught.message).not.toContain(SECRET);
  });
});
