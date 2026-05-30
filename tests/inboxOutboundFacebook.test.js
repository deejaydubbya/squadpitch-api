// Outbound Facebook Page comment reply.
//
// Mirrors the inboxOutboundGbp.test.js fixture pattern: mock
// `prisma`, mock `tokenCrypto`, stub `fetch`, then exercise the
// service for each happy/sad path.

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

const svc = await import("../domains/inbox/inbox.outbound.facebook.service.js");

const CLIENT_A = "client-a";
const CONV_ID = "fb-conv-1";
const PAGE_ID = "100000000000001";
const COMMENT_ID = "fb_comment_12345";

function baseFixture({ overrides = {} } = {}) {
  const messages = [];
  const conversation = {
    id: CONV_ID,
    clientId: CLIENT_A,
    provider: "FACEBOOK",
    spam: false,
    messages: [
      {
        id: "m-comment",
        party: "CONTACT",
        externalMessageId: COMMENT_ID,
        ...overrides.commentMsg,
      },
    ],
    ...overrides.conversation,
  };
  const connection = {
    id: "conn-fb-1",
    clientId: CLIENT_A,
    channel: "FACEBOOK",
    status: "CONNECTED",
    externalAccountId: PAGE_ID,
    accessToken: "enc-PAGE-TOKEN",
    refreshToken: null,
    tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600_000),
    scopes: [
      "public_profile",
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "read_insights",
      "pages_read_user_content",
      "pages_manage_engagement",
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

describe("sendFacebookCommentReply — input validation", () => {
  it("rejects empty body (400 BODY_REQUIRED)", async () => {
    prismaState = baseFixture();
    await expect(
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "  " }),
    ).rejects.toMatchObject({ status: 400, code: "BODY_REQUIRED" });
  });
});

describe("sendFacebookCommentReply — capability gating", () => {
  it("returns 404 CONVERSATION_NOT_FOUND when wrong tenant (tenant scoping)", async () => {
    prismaState = baseFixture();
    await expect(
      svc.sendFacebookCommentReply("other-client", CONV_ID, "user-1", {
        body: "Hi",
      }),
    ).rejects.toMatchObject({ status: 404, code: "CONVERSATION_NOT_FOUND" });
  });

  it("returns 412 WRONG_PROVIDER when conversation isn't FACEBOOK", async () => {
    prismaState = baseFixture({
      overrides: { conversation: { provider: "INSTAGRAM" } },
    });
    await expect(
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 412, code: "WRONG_PROVIDER" });
  });

  it("returns 404 NO_INBOUND_COMMENT when inbound message has no externalMessageId", async () => {
    prismaState = baseFixture({
      overrides: { commentMsg: { externalMessageId: null } },
    });
    await expect(
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 404, code: "NO_INBOUND_COMMENT" });
  });

  it("returns 412 PROVIDER_NOT_AVAILABLE when no FACEBOOK connection exists", async () => {
    prismaState = baseFixture({ overrides: { noConnection: true } });
    await expect(
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 412, code: "PROVIDER_NOT_AVAILABLE" });
  });

  it("returns 412 PROVIDER_NOT_AVAILABLE when pages_manage_engagement is NOT granted", async () => {
    prismaState = baseFixture({
      overrides: {
        connection: {
          scopes: [
            "pages_show_list",
            "pages_read_engagement",
            "pages_manage_posts",
            "read_insights",
            // pages_manage_engagement NOT in this list
          ],
        },
      },
    });
    await expect(
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
      message: expect.stringContaining("pages_manage_engagement"),
    });
  });
});

describe("sendFacebookCommentReply — happy path", () => {
  it("posts to graph.facebook.com/v19.0/{comment-id}/comments with the Page token", async () => {
    prismaState = baseFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "new_fb_reply_999" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const sent = await svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", {
      body: "Thanks for the comment!",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://graph.facebook.com/v19.0/${COMMENT_ID}/comments`,
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const sent_body = String(opts.body);
    expect(sent_body).toContain("message=Thanks");
    // The decrypt mock prefixes with "plain:".
    expect(sent_body).toContain("access_token=plain%3Aenc-PAGE-TOKEN");

    // Outbound message persisted + flipped to SENT with the IG-returned id.
    expect(sent.deliveryStatus).toBe("SENT");
    expect(sent.externalMessageId).toBe("new_fb_reply_999");
    expect(sent.providerMessageId).toBe("new_fb_reply_999");
    expect(sent.visibility).toBe("PUBLIC");
  });
});

describe("sendFacebookCommentReply — Meta error classification", () => {
  it("maps Meta permission errors (code 10/200/230) to PROVIDER_FAILED", async () => {
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
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
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
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 502, code: "PROVIDER_FAILED" });
  });

  it("maps 5xx to PROVIDER_UNREACHABLE (transient)", async () => {
    prismaState = baseFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error: { message: "Bad Gateway" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      svc.sendFacebookCommentReply(CLIENT_A, CONV_ID, "user-1", { body: "Hi" }),
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNREACHABLE" });
  });
});
