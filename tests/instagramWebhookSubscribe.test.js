// Instagram webhook account-subscribe service.
//
// Pins:
//   - Calls graph.instagram.com/{ig-user-id}/subscribed_apps with
//     subscribed_fields=comments and the decrypted access token.
//   - Refuses non-INSTAGRAM connections (WRONG_CHANNEL).
//   - Refuses disconnected connections (CONNECTION_NOT_ACTIVE).
//   - Refuses connections missing instagram_business_manage_comments
//     (MISSING_SCOPE).
//   - Maps Meta error codes: 10/200/230/250 → PROVIDER_PERMISSION_DENIED,
//     190/401 → TOKEN_INVALID, 5xx/429 → PROVIDER_UNREACHABLE.
//   - 404 when the connection id doesn't exist.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaState;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaState;
  },
}));

vi.mock("../lib/tokenCrypto.js", () => ({
  decryptToken: vi.fn((t) => `plain:${t}`),
  encryptToken: vi.fn((t) => `enc:${t}`),
}));

const svc = await import(
  "../domains/studio/instagramWebhookSubscribe.service.js"
);

const CONN_ID = "conn-ig-1";
const IG_USER_ID = "17841444444444444";

function makeConn(overrides = {}) {
  return {
    id: CONN_ID,
    channel: "INSTAGRAM",
    status: "CONNECTED",
    externalAccountId: IG_USER_ID,
    accessToken: "enc-IG-LONG-LIVED",
    scopes: [
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ],
    ...overrides,
  };
}

function installPrisma(conn) {
  prismaState = {
    channelConnection: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === CONN_ID ? conn : null,
      ),
    },
  };
}

function stubFetchOnce({ ok = true, status = 200, body = {} } = {}) {
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  installPrisma(makeConn());
  vi.unstubAllGlobals();
});

describe("subscribeInstagramComments — happy path", () => {
  it("POSTs to graph.instagram.com/{ig-user-id}/subscribed_apps with comments + decrypted token", async () => {
    const fetchMock = stubFetchOnce({ body: { success: true } });

    const result = await svc.subscribeInstagramComments({
      connectionId: CONN_ID,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://graph.instagram.com/${IG_USER_ID}/subscribed_apps` +
        `?subscribed_fields=comments` +
        `&access_token=plain%3Aenc-IG-LONG-LIVED`,
    );
    expect(opts.method).toBe("POST");
    expect(result).toEqual({ success: true, igUserId: IG_USER_ID });
  });

  it("does NOT hit graph.facebook.com — direct IG token only works on graph.instagram.com", async () => {
    const fetchMock = stubFetchOnce({ body: { success: true } });
    await svc.subscribeInstagramComments({ connectionId: CONN_ID });
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).not.toContain("graph.facebook.com");
    }
  });
});

describe("subscribeInstagramComments — validation", () => {
  it("404s when the connection id doesn't exist", async () => {
    installPrisma(null);
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("400s WRONG_CHANNEL when the connection isn't INSTAGRAM", async () => {
    installPrisma(makeConn({ channel: "FACEBOOK" }));
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 400, code: "WRONG_CHANNEL" });
  });

  it("400s CONNECTION_NOT_ACTIVE when status !== CONNECTED", async () => {
    installPrisma(makeConn({ status: "NEEDS_RECONNECT" }));
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 400, code: "CONNECTION_NOT_ACTIVE" });
  });

  it("400s MISSING_SCOPE when instagram_business_manage_comments is absent", async () => {
    installPrisma(
      makeConn({
        scopes: [
          "instagram_business_basic",
          "instagram_business_content_publish",
        ],
      }),
    );
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 400, code: "MISSING_SCOPE" });
  });

  it("does NOT accept the legacy instagram_manage_comments scope", async () => {
    installPrisma(makeConn({ scopes: ["instagram_manage_comments"] }));
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 400, code: "MISSING_SCOPE" });
  });

  it("500s MISSING_EXTERNAL_ACCOUNT_ID when externalAccountId is null", async () => {
    installPrisma(makeConn({ externalAccountId: null }));
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({
      status: 500,
      code: "MISSING_EXTERNAL_ACCOUNT_ID",
    });
  });
});

describe("subscribeInstagramComments — Meta error classification", () => {
  it("maps Meta OAuthException code 10 to PROVIDER_PERMISSION_DENIED", async () => {
    stubFetchOnce({
      ok: false,
      status: 400,
      body: { error: { code: 10, message: "no permission" } },
    });
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROVIDER_PERMISSION_DENIED",
    });
  });

  it("maps Meta code 200 to PROVIDER_PERMISSION_DENIED", async () => {
    stubFetchOnce({
      ok: false,
      status: 400,
      body: { error: { code: 200, message: "permissions error" } },
    });
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROVIDER_PERMISSION_DENIED",
    });
  });

  it("maps Meta code 190 to TOKEN_INVALID", async () => {
    stubFetchOnce({
      ok: false,
      status: 400,
      body: { error: { code: 190, message: "expired token" } },
    });
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 401, code: "TOKEN_INVALID" });
  });

  it("maps 401 to TOKEN_INVALID", async () => {
    stubFetchOnce({
      ok: false,
      status: 401,
      body: { error: { message: "auth" } },
    });
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 401, code: "TOKEN_INVALID" });
  });

  it("maps 5xx to PROVIDER_UNREACHABLE (transient)", async () => {
    stubFetchOnce({
      ok: false,
      status: 503,
      body: { error: { message: "down" } },
    });
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNREACHABLE" });
  });

  it("maps 429 to PROVIDER_UNREACHABLE (rate-limited)", async () => {
    stubFetchOnce({
      ok: false,
      status: 429,
      body: { error: { message: "slow down" } },
    });
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNREACHABLE" });
  });

  it("maps other 4xx without recognized code to PROVIDER_FAILED", async () => {
    stubFetchOnce({
      ok: false,
      status: 400,
      body: { error: { code: 999, message: "weird" } },
    });
    await expect(
      svc.subscribeInstagramComments({ connectionId: CONN_ID }),
    ).rejects.toMatchObject({ status: 502, code: "PROVIDER_FAILED" });
  });
});
