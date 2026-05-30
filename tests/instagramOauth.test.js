// Pin the new Instagram Login / Business Login OAuth behavior so
// nobody accidentally regresses to the old Facebook-Login-via-Page
// flow. These tests intentionally do NOT exercise live Meta calls —
// they verify shape, scopes, hosts, and the resolved exchange path
// via a `fetch` stub.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Stable env shape for the whole file so we can poke individual
// keys per-test without polluting the import.
const ORIGINAL_ENV = { ...process.env };

async function loadFreshModule() {
  // Clear the module cache so `env.js` re-reads process.env after
  // we mutate it. Vitest's `vi.resetModules` is the documented
  // hook for this.
  vi.resetModules();
  return import("../domains/studio/oauth/instagram.oauth.js");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.META_APP_ID = "META-FB-APP";
  process.env.META_APP_SECRET = "META-FB-SECRET";
  process.env.META_OAUTH_REDIRECT_URI =
    "https://api.example.com/oauth/FACEBOOK/callback";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("INSTAGRAM_SCOPES", () => {
  it("is exactly the four instagram_business_* scopes", async () => {
    const mod = await loadFreshModule();
    expect(mod.INSTAGRAM_SCOPES).toEqual([
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ]);
  });

  it("does not include any legacy instagram_* or Facebook Page scope", async () => {
    const mod = await loadFreshModule();
    const banned = [
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_insights",
      "pages_show_list",
      "pages_read_engagement",
      "business_management",
    ];
    for (const s of banned) {
      expect(mod.INSTAGRAM_SCOPES).not.toContain(s);
    }
  });
});

describe("buildAuthUrl", () => {
  it("hits instagram.com/oauth/authorize — never facebook.com", async () => {
    const mod = await loadFreshModule();
    const url = mod.buildAuthUrl({ state: "abc" });
    expect(url.startsWith("https://www.instagram.com/oauth/authorize?")).toBe(true);
    expect(url).not.toContain("facebook.com");
  });

  it("includes force_reauth=true so previously-authorized accounts always see the consent dialog", async () => {
    // Without this param, Instagram tries to reuse a stale
    // session/cookie from the legacy Facebook-Login-via-Page flow
    // and returns "Invalid platform app" on accounts that had
    // previously authorized the old app. Meta's own dashboard
    // recommends including this param for Business Login.
    const mod = await loadFreshModule();
    const url = mod.buildAuthUrl({ state: "abc" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("force_reauth")).toBe("true");
  });

  it("emits the four business scopes and no legacy scope", async () => {
    const mod = await loadFreshModule();
    const url = mod.buildAuthUrl({ state: "abc" });
    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("instagram_business_basic");
    expect(scope).toContain("instagram_business_content_publish");
    expect(scope).toContain("instagram_business_manage_insights");
    expect(scope).toContain("instagram_business_manage_comments");
    expect(scope).not.toContain("pages_show_list");
    expect(scope).not.toContain("pages_read_engagement");
    expect(scope).not.toContain("business_management");
    expect(scope).not.toMatch(/(^|,)instagram_basic(,|$)/);
  });

  it("derives the INSTAGRAM callback from META_OAUTH_REDIRECT_URI when INSTAGRAM_OAUTH_REDIRECT_URI is unset", async () => {
    const mod = await loadFreshModule();
    const url = mod.buildAuthUrl({ state: "abc" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/oauth/INSTAGRAM/callback",
    );
  });

  it("uses INSTAGRAM_* env values when present, ignoring META_* fallback", async () => {
    process.env.INSTAGRAM_APP_ID = "IG-APP";
    process.env.INSTAGRAM_APP_SECRET = "IG-SECRET";
    process.env.INSTAGRAM_OAUTH_REDIRECT_URI =
      "https://api.example.com/oauth/INSTAGRAM/callback";
    const mod = await loadFreshModule();
    const url = mod.buildAuthUrl({ state: "abc" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe("IG-APP");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/oauth/INSTAGRAM/callback",
    );
  });

  it("throws a typed 500 when no credentials are configured", async () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    delete process.env.META_OAUTH_REDIRECT_URI;
    const mod = await loadFreshModule();
    try {
      mod.buildAuthUrl({ state: "abc" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err.code).toBe("INSTAGRAM_NOT_CONFIGURED");
      expect(err.status).toBe(500);
    }
  });
});

describe("exchangeCode", () => {
  function stubFetchSequence(responses) {
    const fetchMock = vi.fn();
    for (const r of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: r.ok ?? true,
        status: r.status ?? 200,
        json: async () => r.body,
      });
    }
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("never calls /me/accounts — Page lookup is gone", async () => {
    const fetchMock = stubFetchSequence([
      { body: { access_token: "SHORT", user_id: 12345 } },
      { body: { access_token: "LONG", expires_in: 5184000 } },
      { body: { id: "12345", username: "smithrealty", account_type: "BUSINESS" } },
    ]);
    const mod = await loadFreshModule();
    await mod.exchangeCode({ code: "auth-code-from-callback" });
    for (const call of fetchMock.mock.calls) {
      const url = call[0];
      expect(url).not.toContain("/me/accounts");
      expect(url).not.toContain("graph.facebook.com");
    }
  });

  it("stores the direct Instagram /me id as externalAccountId", async () => {
    stubFetchSequence([
      { body: { access_token: "SHORT", user_id: 12345 } },
      { body: { access_token: "LONG", expires_in: 5184000 } },
      { body: { id: "12345", username: "smithrealty", account_type: "BUSINESS" } },
    ]);
    const mod = await loadFreshModule();
    const result = await mod.exchangeCode({ code: "abc" });
    expect(result.externalAccountId).toBe("12345");
    expect(result.accessToken).toBe("LONG");
    expect(result.refreshToken).toBeNull();
    expect(result.displayName).toBe("@smithrealty");
    expect(result.scopes).toEqual(mod.INSTAGRAM_SCOPES);
    expect(result.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("falls back to a generic displayName when /me has no username", async () => {
    stubFetchSequence([
      { body: { access_token: "SHORT", user_id: 99 } },
      { body: { access_token: "LONG", expires_in: 5184000 } },
      { body: { id: "99", account_type: "BUSINESS" } },
    ]);
    const mod = await loadFreshModule();
    const result = await mod.exchangeCode({ code: "abc" });
    expect(result.displayName).toBe("Instagram 99");
  });

  it("uses default 60-day expiry when Meta omits expires_in", async () => {
    stubFetchSequence([
      { body: { access_token: "SHORT", user_id: 1 } },
      { body: { access_token: "LONG" } },
      { body: { id: "1", username: "x" } },
    ]);
    const mod = await loadFreshModule();
    const result = await mod.exchangeCode({ code: "abc" });
    const days = (result.tokenExpiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    // Account for the ~ms drift between Date.now() at exchange vs at assert.
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });

  it("uses the new Instagram OAuth hosts", async () => {
    const fetchMock = stubFetchSequence([
      { body: { access_token: "SHORT", user_id: 1 } },
      { body: { access_token: "LONG", expires_in: 5184000 } },
      { body: { id: "1", username: "x" } },
    ]);
    const mod = await loadFreshModule();
    await mod.exchangeCode({ code: "abc" });

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    // Short-lived → api.instagram.com/oauth/access_token
    expect(urls[0]).toBe("https://api.instagram.com/oauth/access_token");
    // Long-lived → graph.instagram.com/access_token?grant_type=ig_exchange_token
    expect(urls[1]).toContain("https://graph.instagram.com/access_token");
    expect(urls[1]).toContain("grant_type=ig_exchange_token");
    // /me → graph.instagram.com/me
    expect(urls[2]).toContain("https://graph.instagram.com/me");
    expect(urls[2]).toContain("fields=");
  });
});
