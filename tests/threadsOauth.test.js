// Threads OAuth tests.
// Covers buildAuthUrl + exchangeCode end-to-end (mocked fetch).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    THREADS_ENABLED: true,
    THREADS_APP_ID: "tapp",
    THREADS_APP_SECRET: "tsecret",
    THREADS_REDIRECT_URI: "https://app.squadpitch.com/oauth/THREADS/callback",
    THREADS_API_VERSION: "v1.0",
  },
}));

const { buildAuthUrl, exchangeCode } = await import(
  "../domains/studio/oauth/threads.oauth.js"
);

const TOKEN = "supersecret-threads-token-xyz";

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

describe("buildAuthUrl", () => {
  it("includes the documented scopes, redirect_uri, and state", () => {
    const url = buildAuthUrl({ state: "STATE123" });
    expect(url).toContain("threads.net/oauth/authorize");
    expect(url).toContain("client_id=tapp");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=STATE123");
    expect(url).toContain(
      encodeURIComponent("https://app.squadpitch.com/oauth/THREADS/callback")
    );
    // Scope set must include all five Threads permissions.
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("threads_basic");
    expect(decoded).toContain("threads_content_publish");
    expect(decoded).toContain("threads_manage_insights");
    expect(decoded).toContain("threads_manage_replies");
    expect(decoded).toContain("threads_read_replies");
  });
});

describe("exchangeCode", () => {
  it("walks code → short token → long token → /me and returns normalized fields", async () => {
    fetchMock
      .mockReturnValueOnce(ok({ access_token: "short", expires_in: 3600 }))
      .mockReturnValueOnce(ok({ access_token: TOKEN, expires_in: 5184000 })) // 60d
      .mockReturnValueOnce(
        ok({ id: "9999", username: "demo_user", threads_profile_picture_url: "http://x" })
      );

    const result = await exchangeCode({ code: "auth_code_123" });
    expect(result.accessToken).toBe(TOKEN);
    expect(result.refreshToken).toBeNull();
    expect(result.externalAccountId).toBe("9999");
    expect(result.displayName).toBe("@demo_user");
    expect(result.scopes).toContain("threads_manage_insights");
    expect(result.scopes).toContain("threads_content_publish");
    expect(result.tokenExpiresAt).toBeInstanceOf(Date);
    // Expiry should land roughly 60 days out.
    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
    const delta = result.tokenExpiresAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(sixtyDaysMs - 60_000);
  });

  it("throws when long-lived exchange returns no access_token", async () => {
    fetchMock
      .mockReturnValueOnce(ok({ access_token: "short" }))
      .mockReturnValueOnce(ok({}));
    await expect(exchangeCode({ code: "x" })).rejects.toThrow(
      /long-lived token missing/i
    );
  });

  it("throws when /me does not return a user id", async () => {
    fetchMock
      .mockReturnValueOnce(ok({ access_token: "short" }))
      .mockReturnValueOnce(ok({ access_token: TOKEN, expires_in: 100 }))
      .mockReturnValueOnce(ok({}))
      // The exchangeCode catches a /me failure and retries against
      // the versioned base — second call must also fail to surface the
      // error.
      .mockReturnValueOnce(ok({}));
    await expect(exchangeCode({ code: "x" })).rejects.toThrow(/user id/i);
  });
});
