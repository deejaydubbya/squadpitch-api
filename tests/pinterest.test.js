// Pinterest — OAuth + boards picker + adapter tests.
//
// Same pattern as tests/linkedinOrg.test.js. We mock prisma + tokenCrypto
// + global.fetch so each module runs in isolation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV = {
  PINTEREST_CLIENT_ID: "pin-client-id",
  PINTEREST_CLIENT_SECRET: "pin-client-secret",
  PINTEREST_REDIRECT_URI: "https://app.squadpitch.com/oauth/PINTEREST/callback",
};

vi.mock("../config/env.js", () => ({ env: { ...ENV } }));

const prismaMock = {
  channelConnection: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../lib/tokenCrypto.js", () => ({
  decryptToken: (s) => `decrypted:${s}`,
}));

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("pinterest.oauth — buildAuthUrl", () => {
  it("includes the documented minimum scope set", async () => {
    const { buildAuthUrl } = await import(
      "../domains/studio/oauth/pinterest.oauth.js"
    );
    const url = buildAuthUrl({ state: "abc" });
    // Pinterest expects scopes COMMA-separated in the auth URL,
    // which URLSearchParams encodes as %2C.
    expect(url).toContain("client_id=pin-client-id");
    // boards:write is required at runtime by Pinterest's /v5/pins
    // even though the docs imply pins:write is enough — sandbox /
    // trial apps reject Pin creation without it (code 3, message
    // "Missing: ['boards:write']"). See pinterest.oauth.js header.
    expect(url).toContain(
      "scope=user_accounts%3Aread%2Cboards%3Aread%2Cboards%3Awrite%2Cpins%3Aread%2Cpins%3Awrite"
    );
    expect(url).toContain("redirect_uri=https%3A%2F%2Fapp.squadpitch.com");
  });

  it("throws PINTEREST_NOT_CONFIGURED when creds are missing", async () => {
    vi.resetModules();
    vi.doMock("../config/env.js", () => ({ env: { PINTEREST_CLIENT_ID: null } }));
    const { buildAuthUrl } = await import(
      "../domains/studio/oauth/pinterest.oauth.js"
    );
    expect(() => buildAuthUrl({ state: "x" })).toThrow(/Pinterest.*not configured/i);
    vi.doUnmock("../config/env.js");
    vi.resetModules();
  });
});

describe("pinterest.oauth — exchangeCode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../config/env.js", () => ({ env: { ...ENV } }));
  });

  it("uses HTTP Basic auth (not body-encoded creds) — common Pinterest gotcha", async () => {
    const fetchMock = vi.fn();
    fetchMock
      // 1st call: token endpoint
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "tok",
          refresh_token: "rtok",
          expires_in: 86400,
          scope: "user_accounts:read,boards:read,pins:read,pins:write",
        }),
      })
      // 2nd call: user_account
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ username: "wardlowdaniel" }),
      });
    global.fetch = fetchMock;

    const { exchangeCode } = await import(
      "../domains/studio/oauth/pinterest.oauth.js"
    );
    const r = await exchangeCode({ code: "auth-code" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.headers.Authorization).not.toMatch(/Bearer/);
    expect(r.accessToken).toBe("tok");
    expect(r.refreshToken).toBe("rtok");
    expect(r.externalAccountId).toBe("wardlowdaniel");
    expect(r.displayName).toBe("@wardlowdaniel");
    expect(r.scopes).toEqual([
      "user_accounts:read",
      "boards:read",
      "pins:read",
      "pins:write",
    ]);
  });

  it("rejects when Pinterest returns no access_token", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: "Authentication failed.", code: 1 }),
    });
    const { exchangeCode } = await import(
      "../domains/studio/oauth/pinterest.oauth.js"
    );
    await expect(exchangeCode({ code: "x" })).rejects.toMatchObject({
      code: "PINTEREST_OAUTH_FAILED",
    });
  });
});

describe("pinterestBoards.service.listBoards", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../config/env.js", () => ({ env: { ...ENV } }));
  });

  it("collects boards across paginated responses (bookmark cursor)", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "PINTEREST",
      accessToken: "stored",
      status: "CONNECTED",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { id: "b1", name: "Listings", privacy: "PUBLIC" },
            { id: "b2", name: "Recipes" },
          ],
          bookmark: "next-cursor",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: "b3", name: "Inspiration", description: "ideas" }],
          // bookmark omitted -> we stop paginating
        }),
      });
    global.fetch = fetchMock;

    const { listBoards } = await import(
      "../domains/studio/pinterestBoards.service.js"
    );
    const boards = await listBoards({ connectionId: "c1" });
    expect(boards).toHaveLength(3);
    expect(boards[0]).toEqual({
      id: "b1",
      name: "Listings",
      description: null,
      privacy: "PUBLIC",
    });
    expect(boards[2].description).toBe("ideas");

    // Verify we passed bookmark on the 2nd call but not the 1st.
    const url1 = fetchMock.mock.calls[0][0];
    const url2 = fetchMock.mock.calls[1][0];
    expect(url1).not.toContain("bookmark=");
    expect(url2).toContain("bookmark=next-cursor");
  });

  it("returns [] when Pinterest returns no items", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "PINTEREST",
      accessToken: "stored",
      status: "CONNECTED",
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    });
    const { listBoards } = await import(
      "../domains/studio/pinterestBoards.service.js"
    );
    const boards = await listBoards({ connectionId: "c1" });
    expect(boards).toEqual([]);
  });

  it("typed PROVIDER_PERMISSION_DENIED on 403", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "PINTEREST",
      accessToken: "stored",
      status: "CONNECTED",
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const { listBoards } = await import(
      "../domains/studio/pinterestBoards.service.js"
    );
    await expect(listBoards({ connectionId: "c1" })).rejects.toMatchObject({
      code: "PROVIDER_PERMISSION_DENIED",
      status: 403,
    });
  });

  it("typed PROVIDER_RATE_LIMITED on 429", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "PINTEREST",
      accessToken: "stored",
      status: "CONNECTED",
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const { listBoards } = await import(
      "../domains/studio/pinterestBoards.service.js"
    );
    await expect(listBoards({ connectionId: "c1" })).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
    });
  });

  it("rejects WRONG_CHANNEL when called with a non-Pinterest connection", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "INSTAGRAM",
      accessToken: "stored",
      status: "CONNECTED",
    });
    const { listBoards } = await import(
      "../domains/studio/pinterestBoards.service.js"
    );
    await expect(listBoards({ connectionId: "c1" })).rejects.toMatchObject({
      code: "WRONG_CHANNEL",
    });
  });
});

describe("pinterest.adapter — publishPost", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("refuses to publish when no board is selected (externalAccountId null)", async () => {
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    await expect(
      pinterestAdapter.publishPost({
        draft: { body: "x", mediaUrl: "https://img/y.jpg" },
        connection: { accessToken: "t", externalAccountId: null },
      })
    ).rejects.toMatchObject({ code: "BOARD_NOT_SELECTED" });
  });

  it("rejects with BOARD_NOT_SELECTED when externalAccountId is the username (no board picked yet)", async () => {
    // After OAuth, externalAccountId is a Pinterest username like
    // "dwardlow0312". Pinterest board ids are numeric (`^\d+$`). We
    // must catch this *before* sending the request, otherwise
    // Pinterest replies with the cryptic
    //   "Invalid request: 'dwardlow0312' does not match '^\\d+$'"
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    await expect(
      pinterestAdapter.publishPost({
        draft: { body: "x", mediaUrl: "https://img/y.jpg" },
        connection: { accessToken: "t", externalAccountId: "dwardlow0312" },
      })
    ).rejects.toMatchObject({ code: "BOARD_NOT_SELECTED" });
  });

  it("refuses to publish without media", async () => {
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    await expect(
      pinterestAdapter.publishPost({
        draft: { body: "x", mediaUrl: null },
        connection: { accessToken: "t", externalAccountId: "1234567890" },
      })
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED_NO_MEDIA" });
  });

  it("refuses video for now (defer to future video-Pin work)", async () => {
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    await expect(
      pinterestAdapter.publishPost({
        draft: { body: "x", mediaUrl: "https://v/y.mp4", mediaType: "video" },
        connection: { accessToken: "t", externalAccountId: "1234567890" },
      })
    ).rejects.toMatchObject({ code: "VIDEO_NOT_SUPPORTED" });
  });

  it("posts an image Pin with the right body shape and returns Pin id + URL", async () => {
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "12345", board_id: "b1" }),
    });
    global.fetch = fetchMock;

    const r = await pinterestAdapter.publishPost({
      draft: {
        body: "Open house this Saturday at 7712 Stonehill Dr",
        hashtags: ["realestate", "openhouse"],
        mediaUrl: "https://squadpitch.com/media-proxy/image/upload/v123/foo.jpg",
        mediaType: "image",
      },
      connection: { accessToken: "tok", externalAccountId: "1234567890" },
      client: { websiteUrl: "https://danielwardlow.com" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.pinterest.com/v5/pins");
    const body = JSON.parse(init.body);
    expect(body.board_id).toBe("1234567890");
    expect(body.media_source).toEqual({
      source_type: "image_url",
      url: "https://squadpitch.com/media-proxy/image/upload/v123/foo.jpg",
    });
    expect(body.title.length).toBeLessThanOrEqual(100);
    expect(body.description).toContain("#realestate");
    expect(body.link).toBe("https://danielwardlow.com");
    expect(r.externalPostId).toBe("12345");
    expect(r.externalPostUrl).toBe("https://www.pinterest.com/pin/12345/");
  });

  it("maps 401/403 to AUTH_FAILED (clean reconnect signal)", async () => {
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "Token expired" }),
    });
    await expect(
      pinterestAdapter.publishPost({
        draft: { body: "x", mediaUrl: "https://img/y.jpg" },
        connection: { accessToken: "t", externalAccountId: "1234567890" },
      })
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("429 throws transient", async () => {
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });
    await expect(
      pinterestAdapter.publishPost({
        draft: { body: "x", mediaUrl: "https://img/y.jpg" },
        connection: { accessToken: "t", externalAccountId: "1234567890" },
      })
    ).rejects.toMatchObject({ transient: true });
  });

  it("maps Trial-access code 29 to PINTEREST_TRIAL_PRODUCTION_BLOCKED (not AUTH_FAILED)", async () => {
    // Pinterest code 29 = "Apps with Trial access may not create Pins
    // in production". Should NOT be AUTH_FAILED — that would tell the
    // operator to reconnect, which won't help. Surface a specific code
    // so the UI can guide them to enable sandbox mode instead.
    const { pinterestAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/pinterest.adapter.js"
    );
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        code: 29,
        message:
          "Apps with Trial access may not create Pins in production https://api.pinterest.com - use API Sandbox https://api-sandbox.pinterest.com instead.",
      }),
    });
    await expect(
      pinterestAdapter.publishPost({
        draft: { body: "x", mediaUrl: "https://img/y.jpg" },
        connection: { accessToken: "t", externalAccountId: "1234567890" },
      })
    ).rejects.toMatchObject({ code: "PINTEREST_TRIAL_PRODUCTION_BLOCKED" });
  });
});

describe("pinterestApi.pinterestApiUrl", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses production host by default", async () => {
    vi.doMock("../config/env.js", () => ({
      env: { ...ENV, PINTEREST_USE_SANDBOX: false },
    }));
    const { pinterestApiUrl } = await import(
      "../domains/studio/oauth/pinterestApi.js"
    );
    expect(pinterestApiUrl("/v5/pins")).toBe("https://api.pinterest.com/v5/pins");
    vi.doUnmock("../config/env.js");
  });

  it("uses sandbox host when PINTEREST_USE_SANDBOX=true", async () => {
    vi.doMock("../config/env.js", () => ({
      env: { ...ENV, PINTEREST_USE_SANDBOX: true },
    }));
    const { pinterestApiUrl } = await import(
      "../domains/studio/oauth/pinterestApi.js"
    );
    expect(pinterestApiUrl("/v5/pins")).toBe(
      "https://api-sandbox.pinterest.com/v5/pins"
    );
    expect(pinterestApiUrl("/v5/boards")).toBe(
      "https://api-sandbox.pinterest.com/v5/boards"
    );
    vi.doUnmock("../config/env.js");
  });
});
