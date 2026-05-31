// Outbound Instagram comment reply.
//
// Mirrors inboxOutboundFacebook.test.js. Additionally asserts that:
// - the NEW scope `instagram_business_manage_comments` is the gate
//   (NOT the legacy `instagram_manage_comments`)
// - the IG Business Login token (long-lived user token, not a Page
//   token) is what's sent to Graph
// - the reply endpoint is `/replies` (NOT `/comments` like FB)

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaState;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaState;
  },
}));

const cryptoMock = {
  decryptToken: vi.fn((t) => `plain:${t}`),
  encryptToken: vi.fn((t) => `enc:${t}`),
};
vi.mock("../lib/tokenCrypto.js", () => cryptoMock);

// ensureValidAccessToken is the token-refresh-or-passthrough helper;
// the IG outbound service calls it and then decrypts the returned
// connection's accessToken. We stub it to return the connection
// unchanged (token still ciphertext) so the test exercises the
// decrypt path the same way production does.
vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: vi.fn(async (conn) => conn),
}));

const svc = await import("../domains/inbox/inbox.outbound.instagram.service.js");

const CLIENT_A = "client-a";
const CONV_ID = "ig-conv-1";
const IG_USER_ID = "17841444444444444";
const IG_COMMENT_ID = "17856789012345678";

function baseFixture({ overrides = {} } = {}) {
  const messages = [];
  const conversation = {
    id: CONV_ID,
    clientId: CLIENT_A,
    provider: "INSTAGRAM",
    spam: false,
    messages: [
      {
        id: "m-comment",
        party: "CONTACT",
        externalMessageId: IG_COMMENT_ID,
        ...overrides.commentMsg,
      },
    ],
    ...overrides.conversation,
  };
  const connection = {
    id: "conn-ig-1",
    clientId: CLIENT_A,
    channel: "INSTAGRAM",
    status: "CONNECTED",
    externalAccountId: IG_USER_ID,
    accessToken: "enc-IG-LONG-LIVED",
    refreshToken: null,
    tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600_000),
    scopes: [
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ],
    ...overrides.connection,
  };
  return {
    conversation: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.id !== conversation.id || where.clientId !== conversation.clientId)
          return null;
        return conversation;
      }),
      update: vi.fn(async () => ({})),
    },
    channelConnection: {
      findUnique: vi.fn(async ({ where }) => {
        if (overrides.noConnection) return null;
        if (where.clientId_channel?.clientId !== connection.clientId) return null;
        if (where.clientId_channel?.channel !== connection.channel) return null;
        return connection;
      }),
    },
    message: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => {
        const m = { id: `m-out-${messages.length + 1}`, createdAt: new Date(), ...data };
        messages.push(m);
        return m;
      }),
      update: vi.fn(async ({ where, data }) => {
        const m = messages.find((x) => x.id === where.id);
        if (m) Object.assign(m, data);
        return m;
      }),
    },
  };
}

beforeEach(() => {
  cryptoMock.decryptToken.mockClear();
  cryptoMock.encryptToken.mockClear();
  vi.restoreAllMocks();
});

describe("sendInstagramCommentReply — capability gating", () => {
  it("returns 404 CONVERSATION_NOT_FOUND when wrong tenant (tenant scoping)", async () => {
    prismaState = baseFixture();
    await expect(
      svc.sendInstagramCommentReply("other-client", CONV_ID, "user-1", {
        body: "Hi",
      }),
    ).rejects.toMatchObject({ status: 404, code: "CONVERSATION_NOT_FOUND" });
  });

  it("returns 412 WRONG_PROVIDER when conversation isn't INSTAGRAM", async () => {
    prismaState = baseFixture({
      overrides: { conversation: { provider: "FACEBOOK" } },
    });
    await expect(
      svc.sendInstagramCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 412, code: "WRONG_PROVIDER" });
  });

  it("returns 412 PROVIDER_NOT_AVAILABLE when no INSTAGRAM connection exists", async () => {
    prismaState = baseFixture({ overrides: { noConnection: true } });
    await expect(
      svc.sendInstagramCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 412, code: "PROVIDER_NOT_AVAILABLE" });
  });

  it("gates on the NEW scope (instagram_business_manage_comments); rejects legacy-only scope set", async () => {
    prismaState = baseFixture({
      overrides: {
        connection: {
          // Legacy scope shape — should NOT pass the gate.
          scopes: [
            "instagram_basic",
            "instagram_content_publish",
            "instagram_manage_insights",
            "instagram_manage_comments",
          ],
        },
      },
    });
    await expect(
      svc.sendInstagramCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
      message: expect.stringContaining("instagram_business_manage_comments"),
    });
  });
});

describe("sendInstagramCommentReply — happy path", () => {
  it("posts to /{ig-comment-id}/replies with the IG Business Login token", async () => {
    prismaState = baseFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "new_ig_reply_888" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const sent = await svc.sendInstagramCommentReply(CLIENT_A, CONV_ID, "user-1", {
      body: "Thanks for the comment!",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    // IG reply endpoint is /replies (FB is /comments).
    // Host is graph.instagram.com — direct IG Business Login tokens
    // are rejected by graph.facebook.com with "Cannot parse access
    // token". Confirmed in prod 2026-05-31 on the publish path.
    expect(url).toBe(
      `https://graph.instagram.com/${IG_COMMENT_ID}/replies`,
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const sent_body = String(opts.body);
    expect(sent_body).toContain("message=Thanks");
    // IG Business Login token (decrypted) — not a Page token.
    expect(sent_body).toContain("access_token=plain%3Aenc-IG-LONG-LIVED");

    expect(sent.deliveryStatus).toBe("SENT");
    expect(sent.externalMessageId).toBe("new_ig_reply_888");
    expect(sent.providerMessageId).toBe("new_ig_reply_888");
    expect(sent.visibility).toBe("PUBLIC");
  });
});

describe("sendInstagramCommentReply — Meta error classification", () => {
  it("maps Meta permission errors (code 10) to PROVIDER_FAILED", async () => {
    prismaState = baseFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 10, message: "Application does not have permission" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      svc.sendInstagramCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_FAILED",
      message: expect.stringContaining("permission"),
    });
  });

  it("maps OAuthException (code 190) to PROVIDER_FAILED", async () => {
    prismaState = baseFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: 190, message: "Access token has expired" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      svc.sendInstagramCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 502, code: "PROVIDER_FAILED" });
  });

  it("maps 5xx to PROVIDER_UNREACHABLE (transient)", async () => {
    prismaState = baseFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: { message: "Bad Gateway" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      svc.sendInstagramCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNREACHABLE" });
  });
});
