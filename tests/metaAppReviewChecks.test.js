// metaAppReviewChecks.service tests.
//
// Exercises the diagnostic tool that hits one Page-level Insights
// endpoint (read_insights) and one IG user-level Insights endpoint
// (instagram_manage_insights). Critical assertions:
//   - happy paths return success + metric names
//   - non-permission errors trigger the documented fallbacks
//   - permission errors do NOT trigger fallbacks (those signal a
//     missing scope, not a missing metric)
//   - access tokens never appear in returned endpoint URLs or messages
//   - the orchestrator runs both checks even when one throws

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../domains/studio/meta.constants.js", () => ({
  META_GRAPH_BASE: "https://graph.test/v19.0",
  META_GRAPH_VERSION: "v19.0",
}));
vi.mock("../config/env.js", () => ({
  env: { META_APP_ID: "appid", META_APP_SECRET: "appsecret" },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const connectionMock = vi.fn();
const tokenRefreshMock = vi.fn();

vi.mock("../domains/studio/connection.service.js", () => ({
  getConnectionForAdapter: (...args) => connectionMock(...args),
}));
vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: (c) => tokenRefreshMock(c),
}));

const {
  runFacebookPageInsightsCheck,
  runInstagramInsightsCheck,
  runMetaAppReviewChecks,
} = await import("../domains/studio/metaAppReviewChecks.service.js");

const FB_TOKEN = "supersecret-fb-page-token-xyz";
const IG_TOKEN = "supersecret-ig-page-token-abc";
const PAGE_ID = "100000000000001";
const IG_USER_ID = "17841444444444444";

let fetchMock;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  vi.clearAllMocks();
  // Default: token refresh is a no-op pass-through.
  tokenRefreshMock.mockImplementation(async (c) => c);
});
afterEach(() => {
  global.fetch = originalFetch;
});

const ok = (body) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });
const err = (status, body = {}) =>
  Promise.resolve({ ok: false, status, json: async () => body });

const fbConn = () => ({
  status: "CONNECTED",
  channel: "FACEBOOK",
  externalAccountId: PAGE_ID,
  accessToken: FB_TOKEN,
});
const igConn = () => ({
  status: "CONNECTED",
  channel: "INSTAGRAM",
  externalAccountId: IG_USER_ID,
  accessToken: IG_TOKEN,
});

// ── Facebook Page Insights ───────────────────────────────────────────

describe("runFacebookPageInsightsCheck", () => {
  it("returns success when page_impressions returns data", async () => {
    fetchMock.mockReturnValueOnce(
      ok({
        data: [{ name: "page_impressions", values: [{ value: 1234 }] }],
      })
    );
    const r = await runFacebookPageInsightsCheck(fbConn());
    expect(r.success).toBe(true);
    expect(r.attempted).toBe(true);
    expect(r.metrics).toEqual(["page_impressions"]);
    expect(r.endpoint).not.toContain(FB_TOKEN);
    expect(r.endpoint).toContain("access_token=REDACTED");
  });

  it("falls back to page_post_engagements when primary metric is unavailable (non-permission error)", async () => {
    fetchMock
      .mockReturnValueOnce(
        err(400, {
          error: { code: 100, message: "metric does not exist" },
        })
      )
      .mockReturnValueOnce(
        ok({
          data: [{ name: "page_post_engagements", values: [{ value: 5 }] }],
        })
      );
    const r = await runFacebookPageInsightsCheck(fbConn());
    expect(r.success).toBe(true);
    expect(r.metrics).toEqual(["page_post_engagements"]);
    expect(r.message).toContain("page_post_engagements");
  });

  it("does NOT fall back when primary metric returns a permission error (code 10)", async () => {
    fetchMock.mockReturnValueOnce(
      err(403, {
        error: { code: 10, message: "Application does not have permission" },
      })
    );
    const r = await runFacebookPageInsightsCheck(fbConn());
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("10");
    // Only one fetch call — fallback skipped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns attempted: false when no connection is provided", async () => {
    const r = await runFacebookPageInsightsCheck(null);
    expect(r.attempted).toBe(false);
    expect(r.success).toBe(false);
    expect(r.endpoint).not.toContain("undefined");
  });

  it("never includes the access token in any returned field", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, {
        error: { code: 100, message: `bad with token ${FB_TOKEN}` },
      })
    );
    fetchMock.mockReturnValueOnce(
      err(400, {
        error: { code: 100, message: `also bad with ${FB_TOKEN}` },
      })
    );
    const r = await runFacebookPageInsightsCheck(fbConn());
    expect(JSON.stringify(r)).not.toContain(FB_TOKEN);
  });
});

// ── Instagram Insights ───────────────────────────────────────────────

describe("runInstagramInsightsCheck", () => {
  it("returns success when user-level insights returns data", async () => {
    fetchMock.mockReturnValueOnce(
      ok({
        data: [
          { name: "reach", values: [{ value: 1000 }] },
          { name: "profile_views", values: [{ value: 50 }] },
        ],
      })
    );
    const r = await runInstagramInsightsCheck(igConn());
    expect(r.success).toBe(true);
    expect(r.metrics).toEqual(["reach", "profile_views"]);
    expect(r.endpoint).toContain("access_token=REDACTED");
  });

  it("falls back to media insights when user-level fails for non-permission reason", async () => {
    fetchMock
      // 1. user-level insights — 400, metric unavailable
      .mockReturnValueOnce(
        err(400, {
          error: { code: 100, message: "metric not available" },
        })
      )
      // 2. recent media list — ok with 1 media
      .mockReturnValueOnce(
        ok({ data: [{ id: "ig-media-99", media_type: "IMAGE" }] })
      )
      // 3. media insights — ok
      .mockReturnValueOnce(
        ok({
          data: [
            { name: "reach", values: [{ value: 200 }] },
            { name: "likes", values: [{ value: 30 }] },
            { name: "comments", values: [{ value: 5 }] },
            { name: "saved", values: [{ value: 2 }] },
            { name: "shares", values: [{ value: 1 }] },
          ],
        })
      );
    const r = await runInstagramInsightsCheck(igConn());
    expect(r.success).toBe(true);
    expect(r.metrics).toEqual(["reach", "likes", "comments", "saved", "shares"]);
    expect(r.message).toContain("media-level");
    expect(r.message).toContain("ig-media-99");
  });

  it("returns failure when fallback media list is empty", async () => {
    fetchMock
      .mockReturnValueOnce(
        err(400, { error: { code: 100, message: "metric not available" } })
      )
      .mockReturnValueOnce(ok({ data: [] }));
    const r = await runInstagramInsightsCheck(igConn());
    expect(r.success).toBe(false);
    expect(r.message).toContain("no recent media");
  });

  it("does NOT fall back when user-level returns permission denied", async () => {
    fetchMock.mockReturnValueOnce(
      err(403, {
        error: { code: 10, message: "permission denied" },
      })
    );
    const r = await runInstagramInsightsCheck(igConn());
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("10");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never includes the access token in returned fields", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, {
        error: { code: 100, message: `bad with ${IG_TOKEN}` },
      })
    );
    fetchMock.mockReturnValueOnce(
      err(500, { error: { code: 1, message: `server with ${IG_TOKEN}` } })
    );
    const r = await runInstagramInsightsCheck(igConn());
    expect(JSON.stringify(r)).not.toContain(IG_TOKEN);
  });
});

// ── Orchestrator ─────────────────────────────────────────────────────

describe("runMetaAppReviewChecks", () => {
  it("runs both checks and returns nextSteps when both succeed", async () => {
    connectionMock
      .mockResolvedValueOnce(fbConn())   // FACEBOOK
      .mockResolvedValueOnce(igConn());  // INSTAGRAM
    fetchMock
      // FB page_impressions
      .mockReturnValueOnce(
        ok({ data: [{ name: "page_impressions", values: [{ value: 100 }] }] })
      )
      // IG user-level insights
      .mockReturnValueOnce(
        ok({ data: [{ name: "reach", values: [{ value: 200 }] }] })
      )
      // FB debug_token
      .mockReturnValueOnce(
        ok({ data: { scopes: ["read_insights", "pages_read_engagement"] } })
      )
      // IG debug_token
      .mockReturnValueOnce(
        ok({
          data: {
            scopes: ["instagram_manage_insights", "instagram_basic"],
          },
        })
      );

    const r = await runMetaAppReviewChecks("c1");
    expect(r.facebook.success).toBe(true);
    expect(r.instagram.success).toBe(true);
    expect(r.tokenScopes.facebook).toContain("read_insights");
    expect(r.tokenScopes.instagram).toContain("instagram_manage_insights");
    expect(r.nextSteps.some((s) => s.includes("Both calls succeeded"))).toBe(true);
  });

  it("surfaces missing-scope nextStep when token lacks the scope", async () => {
    connectionMock
      .mockResolvedValueOnce(fbConn())
      .mockResolvedValueOnce(null); // no IG connection
    fetchMock
      .mockReturnValueOnce(
        err(403, { error: { code: 10, message: "no permission" } })
      )
      // debug_token for FB returns scopes WITHOUT read_insights
      .mockReturnValueOnce(
        ok({ data: { scopes: ["pages_read_engagement"] } })
      );

    const r = await runMetaAppReviewChecks("c1");
    expect(r.facebook.success).toBe(false);
    expect(r.instagram.attempted).toBe(false);
    expect(
      r.nextSteps.some((s) => s.includes("read_insights"))
    ).toBe(true);
  });

  it("does not abort when one check throws — the other still runs", async () => {
    connectionMock
      .mockResolvedValueOnce(fbConn())
      .mockResolvedValueOnce(igConn());

    // Make the FB fetch throw (network-layer error), then succeed
    // for IG.
    fetchMock
      .mockImplementationOnce(() => {
        throw new Error("ECONNRESET");
      })
      // IG user-level insights succeeds
      .mockReturnValueOnce(
        ok({ data: [{ name: "reach", values: [{ value: 1 }] }] })
      )
      // debug_token calls (both ok with empty)
      .mockReturnValueOnce(ok({ data: { scopes: [] } }))
      .mockReturnValueOnce(ok({ data: { scopes: [] } }));

    const r = await runMetaAppReviewChecks("c1");
    expect(r.facebook.success).toBe(false);
    expect(r.facebook.message).toContain("ECONNRESET");
    expect(r.instagram.success).toBe(true);
  });
});
