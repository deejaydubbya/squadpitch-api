// Pins the Facebook OAuth scope shape after IG-05 (which added the
// public-comment scopes) and the separation invariant between the
// Facebook and Instagram OAuth modules (different scope arrays,
// different login hosts).
//
// No live Meta calls — `buildAuthUrl` is pure given env config.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadModules() {
  vi.resetModules();
  const fb = await import("../domains/studio/oauth/facebook.oauth.js");
  const ig = await import("../domains/studio/oauth/instagram.oauth.js");
  return { fb, ig };
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

describe("FACEBOOK_SCOPES", () => {
  it("is exactly the six target Page scopes (IG-05)", async () => {
    const { fb } = await loadModules();
    expect(fb.FACEBOOK_SCOPES).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "read_insights",
      "pages_read_user_content",
      "pages_manage_engagement",
    ]);
  });

  it("never includes any Messenger / DM scope", async () => {
    const { fb } = await loadModules();
    for (const dm of [
      "pages_messaging",
      "pages_messaging_subscriptions",
      "instagram_business_manage_messages",
      "instagram_manage_messages",
    ]) {
      expect(fb.FACEBOOK_SCOPES).not.toContain(dm);
    }
  });

  it("never includes any Instagram scope", async () => {
    const { fb } = await loadModules();
    for (const igScope of [
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_insights",
      "instagram_manage_comments",
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ]) {
      expect(fb.FACEBOOK_SCOPES).not.toContain(igScope);
    }
  });
});

describe("Facebook buildAuthUrl", () => {
  it("uses facebook.com (Facebook Login) and emits all six scopes", async () => {
    const { fb } = await loadModules();
    const url = fb.buildAuthUrl({ state: "abc" });
    expect(url.startsWith("https://www.facebook.com/")).toBe(true);
    expect(url).toContain("dialog/oauth");
    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("pages_show_list");
    expect(scope).toContain("pages_read_engagement");
    expect(scope).toContain("pages_manage_posts");
    expect(scope).toContain("read_insights");
    expect(scope).toContain("pages_read_user_content");
    expect(scope).toContain("pages_manage_engagement");
  });
});

describe("IG vs FB OAuth separation", () => {
  it("the two scope arrays do not share a single scope", async () => {
    const { fb, ig } = await loadModules();
    const fbSet = new Set(fb.FACEBOOK_SCOPES);
    for (const igScope of ig.INSTAGRAM_SCOPES) {
      expect(fbSet.has(igScope)).toBe(false);
    }
  });

  it("Instagram auth URL never contains a Facebook Page scope", async () => {
    process.env.INSTAGRAM_APP_ID = "IG-APP";
    process.env.INSTAGRAM_APP_SECRET = "IG-SECRET";
    process.env.INSTAGRAM_OAUTH_REDIRECT_URI =
      "https://api.example.com/oauth/INSTAGRAM/callback";
    const { ig } = await loadModules();
    const url = ig.buildAuthUrl({ state: "abc" });
    const scope = new URL(url).searchParams.get("scope") ?? "";
    for (const pageScope of [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "read_insights",
      "pages_read_user_content",
      "pages_manage_engagement",
      "business_management",
    ]) {
      expect(scope).not.toContain(pageScope);
    }
  });

  it("uses different login hosts (facebook.com vs instagram.com)", async () => {
    process.env.INSTAGRAM_APP_ID = "IG-APP";
    process.env.INSTAGRAM_APP_SECRET = "IG-SECRET";
    process.env.INSTAGRAM_OAUTH_REDIRECT_URI =
      "https://api.example.com/oauth/INSTAGRAM/callback";
    const { fb, ig } = await loadModules();
    const fbUrl = fb.buildAuthUrl({ state: "abc" });
    const igUrl = ig.buildAuthUrl({ state: "abc" });
    expect(new URL(fbUrl).hostname).toBe("www.facebook.com");
    expect(new URL(igUrl).hostname).toBe("www.instagram.com");
  });
});
