// Phase IG-02 — Instagram token refresh adapter + dispatcher wiring.
//
// Verifies that:
//   - getRefreshAdapter("INSTAGRAM") returns the new instagram-
//     specific adapter (not metaRefresh) post-migration.
//   - A successful refresh response yields a fresh ~60-day expiry
//     and the new access token.
//   - 4xx surfaces as canRefresh:false so tokenRefreshService can
//     flip the connection to NEEDS_RECONNECT.
//   - 5xx / 429 throws so the refresh job's backoff path retries.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRefreshAdapter } from "../domains/studio/token-refresh/index.js";
import { instagramRefresh } from "../domains/studio/token-refresh/instagram.refresh.js";
import { metaRefresh } from "../domains/studio/token-refresh/meta.refresh.js";

describe("getRefreshAdapter dispatcher", () => {
  it("returns the Instagram-specific adapter, not metaRefresh", () => {
    const adapter = getRefreshAdapter("INSTAGRAM");
    expect(adapter).toBe(instagramRefresh);
    expect(adapter).not.toBe(metaRefresh);
  });

  it("still routes FACEBOOK to metaRefresh", () => {
    expect(getRefreshAdapter("FACEBOOK")).toBe(metaRefresh);
  });

  it("returns null for unknown channels", () => {
    expect(getRefreshAdapter("BOGUS")).toBeNull();
  });
});

describe("instagramRefresh.refresh", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetchOnce({ ok = true, status = 200, body }) {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok,
      status,
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns canRefresh:false when the connection has no token", async () => {
    const result = await instagramRefresh.refresh({});
    expect(result).toEqual({ canRefresh: false });
  });

  it("hits graph.instagram.com/refresh_access_token with ig_refresh_token grant", async () => {
    const fetchMock = stubFetchOnce({
      body: { access_token: "FRESH", expires_in: 5184000 },
    });
    await instagramRefresh.refresh({ accessToken: "OLD-LONG-LIVED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("https://graph.instagram.com/refresh_access_token");
    expect(url).toContain("grant_type=ig_refresh_token");
    expect(url).toContain("access_token=OLD-LONG-LIVED");
    // Must NOT call meta/facebook hosts.
    expect(url).not.toContain("graph.facebook.com");
  });

  it("persists a fresh ~60-day token on success", async () => {
    stubFetchOnce({
      body: { access_token: "FRESH-LONG-LIVED", expires_in: 5184000 },
    });
    const result = await instagramRefresh.refresh({
      accessToken: "OLD-LONG-LIVED",
    });
    expect(result.accessToken).toBe("FRESH-LONG-LIVED");
    expect(result.refreshToken).toBeNull();
    const days =
      (result.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });

  it("defaults expiry to 60d when Meta omits expires_in", async () => {
    stubFetchOnce({ body: { access_token: "FRESH" } });
    const result = await instagramRefresh.refresh({
      accessToken: "OLD",
    });
    const days =
      (result.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });

  it("flags canRefresh:false on 4xx with the Meta error code surfaced", async () => {
    stubFetchOnce({
      ok: false,
      status: 400,
      body: {
        error: {
          message: "Access token has expired beyond refresh window",
          code: 190,
        },
      },
    });
    const result = await instagramRefresh.refresh({ accessToken: "OLD" });
    expect(result.canRefresh).toBe(false);
    expect(result.error).toContain("Access token has expired");
    expect(result.providerCode).toBe(190);
  });

  it("treats 401 as canRefresh:false (revoked/expired)", async () => {
    stubFetchOnce({
      ok: false,
      status: 401,
      body: { error: { message: "OAuthException", code: 190 } },
    });
    const result = await instagramRefresh.refresh({ accessToken: "OLD" });
    expect(result.canRefresh).toBe(false);
  });

  it("throws on 5xx so the refresh job retries", async () => {
    stubFetchOnce({
      ok: false,
      status: 500,
      body: { error: { message: "Internal server error" } },
    });
    await expect(
      instagramRefresh.refresh({ accessToken: "OLD" }),
    ).rejects.toThrow(/Internal server error/);
  });

  it("throws on 429 (rate limit) so the refresh job backs off", async () => {
    stubFetchOnce({
      ok: false,
      status: 429,
      body: { error: { message: "Too many requests" } },
    });
    await expect(
      instagramRefresh.refresh({ accessToken: "OLD" }),
    ).rejects.toThrow(/Too many requests/);
  });

  it("flags canRefresh:false if the response is 200 but missing access_token", async () => {
    stubFetchOnce({ body: { expires_in: 5184000 } });
    const result = await instagramRefresh.refresh({ accessToken: "OLD" });
    expect(result.canRefresh).toBe(false);
    expect(result.error).toContain("access_token");
  });
});
