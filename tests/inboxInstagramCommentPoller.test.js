// Instagram comment polling service tests.
//
// Same mock shape as inboxFacebookCommentPoller.test.js. Additionally
// asserts that:
//   - the Graph URL is graph.instagram.com (NOT graph.facebook.com)
//   - the IG Business Login token (long-lived user token) is what's
//     sent to Graph
//   - the IG-specific scope `instagram_business_manage_comments` is
//     the gate
//   - comments with no `from.id` are skipped with MISSING_FROM_ID
//     (depends on commenter settings / API version)

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const cryptoMock = {
  decryptToken: vi.fn((t) => `plain:${t}`),
  encryptToken: vi.fn((t) => `enc:${t}`),
};
vi.mock("../lib/tokenCrypto.js", () => cryptoMock);

vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: vi.fn(async (conn) => conn),
}));

const svc = await import(
  "../domains/inbox/inbox.instagramCommentPoller.service.js"
);

const CLIENT_A = "client-ig-a";
const IG_USER_ID = "17841444444444444";
const MEDIA_ID = "ig_media_777";

function makePrismaMock({ drafts = [], connection = null } = {}) {
  const state = {
    drafts,
    channelConnections: connection ? [connection] : [],
    conversations: new Map(),
    messages: [],
    contacts: new Map(),
    convCounter: 0,
    contactCounter: 0,
    messageCounter: 0,
    connectionUpdates: [],
  };
  return {
    state,
    draft: {
      findMany: vi.fn(async ({ where }) => {
        return state.drafts.filter(
          (d) =>
            d.clientId === where.clientId &&
            d.channel === where.channel &&
            d.externalPostId &&
            (!where.publishedAt?.gte ||
              new Date(d.publishedAt) >= new Date(where.publishedAt.gte)),
        );
      }),
    },
    channelConnection: {
      findUnique: vi.fn(async ({ where }) => {
        const k = where.clientId_channel;
        if (!k) return null;
        return (
          state.channelConnections.find(
            (c) => c.clientId === k.clientId && c.channel === k.channel,
          ) ?? null
        );
      }),
      findMany: vi.fn(async () => state.channelConnections),
      update: vi.fn(async ({ where, data }) => {
        const c = state.channelConnections.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        state.connectionUpdates.push({ id: where.id, data });
        return c;
      }),
    },
    conversation: {
      count: vi.fn(async ({ where }) => {
        let n = 0;
        for (const c of state.conversations.values()) {
          if (where.clientId && c.clientId !== where.clientId) continue;
          if (where.provider && c.provider !== where.provider) continue;
          n += 1;
        }
        return n;
      }),
      findFirst: vi.fn(async ({ where }) => {
        for (const c of state.conversations.values()) {
          if (where.clientId && c.clientId !== where.clientId) continue;
          if (where.provider && c.provider !== where.provider) continue;
          if (
            where.externalThreadId !== undefined &&
            c.externalThreadId !== where.externalThreadId
          )
            continue;
          return c;
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `conv-${++state.convCounter}`;
        const row = { id, ...data };
        state.conversations.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.conversations.get(where.id);
        const next = { ...row, ...data };
        state.conversations.set(where.id, next);
        return next;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }) => {
        for (const c of state.contacts.values()) {
          if (where.clientId && c.clientId !== where.clientId) continue;
          if (where.enrichmentJson?.path) {
            const [head, sub] = where.enrichmentJson.path;
            const val = c.enrichmentJson?.[head]?.[sub];
            if (val === where.enrichmentJson.equals) return c;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `contact-${++state.contactCounter}`;
        const row = { id, ...data };
        state.contacts.set(id, row);
        return row;
      }),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        if (!where.externalMessageId) return null;
        const m = state.messages.find(
          (msg) => msg.externalMessageId === where.externalMessageId,
        );
        if (!m) return null;
        const conv = state.conversations.get(m.conversationId);
        if (where.conversation?.clientId && conv?.clientId !== where.conversation.clientId)
          return null;
        if (where.conversation?.provider && conv?.provider !== where.conversation.provider)
          return null;
        return { id: m.id, conversationId: m.conversationId };
      }),
      create: vi.fn(async ({ data }) => {
        const id = `msg-${++state.messageCounter}`;
        const row = {
          id,
          createdAt: data.createdAt instanceof Date ? data.createdAt : new Date(),
          ...data,
        };
        state.messages.push(row);
        return row;
      }),
    },
  };
}

function igConnectionFixture(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function igDraftFixture(overrides = {}) {
  return {
    id: "draft-ig-1",
    clientId: CLIENT_A,
    channel: "INSTAGRAM",
    externalPostId: MEDIA_ID,
    externalPostUrl: `https://instagram.com/p/${MEDIA_ID}`,
    publishedAt: new Date(Date.now() - 24 * 60 * 60_000),
    ...overrides,
  };
}

function igCommentFixture(id, overrides = {}) {
  return {
    id,
    text: `ig comment ${id}`,
    username: `user_${id}`,
    timestamp: "2026-06-01T12:00:00+0000",
    like_count: 0,
    from: { id: `ig_user_${id}`, username: `user_${id}` },
    ...overrides,
  };
}

beforeEach(() => {
  cryptoMock.decryptToken.mockClear();
  vi.restoreAllMocks();
});

describe("pollInstagramCommentsForWorkspace — host + token + happy path", () => {
  it("hits graph.instagram.com (NOT graph.facebook.com) with the IG user token", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture(),
      drafts: [igDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [igCommentFixture("c1"), igCommentFixture("c2")],
        paging: {},
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/graph\.instagram\.com\//);
    expect(url).not.toContain("graph.facebook.com");
    expect(url).toContain(`/${encodeURIComponent(MEDIA_ID)}/comments`);
    expect(url).toContain("access_token=plain%3Aenc-IG-LONG-LIVED");

    expect(summary.mediaChecked).toBe(1);
    expect(summary.commentsFetched).toBe(2);
    expect(summary.messagesCreated).toBe(2);
    expect(summary.conversationsCreated).toBe(1);
    expect(summary.duplicatesSkipped).toBe(0);
    expect(summary.errors).toEqual([]);
  });
});

describe("pollInstagramCommentsForWorkspace — idempotency", () => {
  it("re-polling the same comments yields 0 created, 2 duplicates", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture(),
      drafts: [igDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [igCommentFixture("c1"), igCommentFixture("c2")],
        paging: {},
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });
    expect(first.messagesCreated).toBe(2);

    const second = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });
    expect(second.messagesCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
    expect(prismaMock.state.messages.length).toBe(2);
  });
});

describe("pollInstagramCommentsForWorkspace — echo guard", () => {
  it("skips comments whose from.id equals the IG user id (ECHO_FROM_ACCOUNT)", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture(),
      drafts: [igDraftFixture()],
    });
    const echoComment = igCommentFixture("c_echo", {
      from: { id: IG_USER_ID, username: "self" },
    });
    const realComment = igCommentFixture("c_real");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [echoComment, realComment], paging: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.commentsFetched).toBe(2);
    expect(summary.messagesCreated).toBe(1);
    expect(summary.errors.some((e) => e.message === "ECHO_FROM_ACCOUNT")).toBe(true);
  });
});

describe("pollInstagramCommentsForWorkspace — missing from.id", () => {
  it("gracefully skips comments with no from.id (MISSING_FROM_ID)", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture(),
      drafts: [igDraftFixture()],
    });
    const anonymousComment = igCommentFixture("c_anon", { from: undefined });
    const realComment = igCommentFixture("c_real");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [anonymousComment, realComment], paging: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.commentsFetched).toBe(2);
    expect(summary.messagesCreated).toBe(1);
    expect(summary.errors.some((e) => e.message === "MISSING_FROM_ID")).toBe(true);
  });
});

describe("pollInstagramCommentsForWorkspace — missing required scope", () => {
  it("skips the connection when instagram_business_manage_comments is absent", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture({
        scopes: ["instagram_business_basic", "instagram_business_content_publish"],
      }),
      drafts: [igDraftFixture()],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.mediaChecked).toBe(0);
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(summary.errors[0].message).toContain("MISSING_REQUIRED_SCOPE");
    expect(summary.errors[0].message).toContain("instagram_business_manage_comments");
  });

  it("rejects the legacy scope (instagram_manage_comments) as not sufficient", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture({
        scopes: [
          "instagram_basic",
          "instagram_content_publish",
          "instagram_manage_insights",
          "instagram_manage_comments", // LEGACY — should NOT pass the gate
        ],
      }),
      drafts: [igDraftFixture()],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.errors[0].message).toContain("instagram_business_manage_comments");
  });
});

describe("pollInstagramCommentsForWorkspace — error classification", () => {
  it("401 from Graph flips connection to NEEDS_RECONNECT and bails", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture(),
      drafts: [igDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        error: { message: "Invalid OAuth access token - Cannot parse access token" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.errors.some((e) => e.message.startsWith("AUTH_FAILED:401"))).toBe(true);
    expect(prismaMock.state.connectionUpdates).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_RECONNECT" }),
      }),
    );
  });

  it("5xx from Graph is transient — error logged, no status change", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture(),
      drafts: [igDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: { message: "Bad Gateway" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.errors.some((e) => e.message.startsWith("TRANSIENT:502"))).toBe(true);
    const statusUpdates = prismaMock.state.connectionUpdates.filter((u) => u.data?.status);
    expect(statusUpdates).toEqual([]);
  });

  it("404 on a media item is non-fatal — continues with the rest", async () => {
    prismaMock = makePrismaMock({
      connection: igConnectionFixture(),
      drafts: [
        igDraftFixture({ id: "d1", externalPostId: "ig_media_a" }),
        igDraftFixture({ id: "d2", externalPostId: "ig_media_b" }),
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: "Unsupported get request" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [igCommentFixture("c1")], paging: {} }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.mediaChecked).toBe(2);
    expect(summary.messagesCreated).toBe(1);
    expect(summary.errors.some((e) => e.message.startsWith("MEDIA_NOT_FOUND:404"))).toBe(true);
  });
});

describe("pollInstagramCommentsForWorkspace — no connection", () => {
  it("returns an error when the workspace has no INSTAGRAM connection", async () => {
    prismaMock = makePrismaMock({ connection: null, drafts: [] });
    const summary = await svc.pollInstagramCommentsForWorkspace({ clientId: CLIENT_A });
    expect(summary.errors.some((e) => e.message === "NO_INSTAGRAM_CONNECTION")).toBe(true);
    expect(summary.mediaChecked).toBe(0);
  });
});
