// Facebook comment polling service tests.
//
// Mocks prisma + fetch + tokenCrypto + tokenRefreshService the same
// way inboxOutboundInstagram.test.js does. Exercises:
//   - Happy path (1 draft, 2 comments → 2 messages created)
//   - Idempotency (re-polling → 0 created, 2 duplicates)
//   - Echo skip (comment from the Page id itself → skipped)
//   - Missing required scope (skips connection, clear error)
//   - 401/403 → connection flipped to NEEDS_RECONNECT
//   - 5xx → transient error logged, no status change
//   - Pagination cap (stops at 5 pages even if `next` cursor present)

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

// Shared comment-ingestion helper isn't mocked — we let the real one
// run against the in-memory prisma mock so idempotency, contact
// dedupe, and conversation grouping are exercised end-to-end.
const svc = await import(
  "../domains/inbox/inbox.facebookCommentPoller.service.js"
);

const CLIENT_A = "client-fb-a";
const FB_PAGE_ID = "fb-page-9999";
const POST_ID = "fb_post_123";

function makePrismaMock({ drafts = [], connection = null, conversations = [] } = {}) {
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
  for (const c of conversations) state.conversations.set(c.id, c);

  return {
    state,
    draft: {
      findMany: vi.fn(async ({ where }) => {
        // Filter by clientId + channel + externalPostId not null + publishedAt gte
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

function fbConnectionFixture(overrides = {}) {
  return {
    id: "conn-fb-1",
    clientId: CLIENT_A,
    channel: "FACEBOOK",
    status: "CONNECTED",
    externalAccountId: FB_PAGE_ID,
    accessToken: "enc-FB-PAGE-TOKEN",
    refreshToken: null,
    tokenExpiresAt: null,
    scopes: [
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
      "pages_read_user_content",
      "pages_manage_engagement",
    ],
    ...overrides,
  };
}

function fbDraftFixture(overrides = {}) {
  return {
    id: "draft-1",
    clientId: CLIENT_A,
    channel: "FACEBOOK",
    externalPostId: POST_ID,
    externalPostUrl: `https://facebook.com/${POST_ID}`,
    publishedAt: new Date(Date.now() - 24 * 60 * 60_000), // yesterday
    ...overrides,
  };
}

function fbCommentFixture(id, overrides = {}) {
  return {
    id,
    message: `comment ${id}`,
    from: { id: `fb_user_${id}`, name: `User ${id}` },
    created_time: "2026-06-01T12:00:00+0000",
    parent: null,
    comment_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  cryptoMock.decryptToken.mockClear();
  vi.restoreAllMocks();
});

describe("pollFacebookCommentsForWorkspace — happy path", () => {
  it("creates one Message per comment (2 comments → 2 messages, 1 conversation)", async () => {
    prismaMock = makePrismaMock({
      connection: fbConnectionFixture(),
      drafts: [fbDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [fbCommentFixture("c1"), fbCommentFixture("c2")],
        paging: {},
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("https://graph.facebook.com/v19.0/");
    expect(url).toContain(`/${encodeURIComponent(POST_ID)}/comments`);
    expect(url).toContain("fields=");
    expect(url).toContain("access_token=plain%3Aenc-FB-PAGE-TOKEN");

    expect(summary.postsChecked).toBe(1);
    expect(summary.commentsFetched).toBe(2);
    expect(summary.messagesCreated).toBe(2);
    expect(summary.conversationsCreated).toBe(1);
    expect(summary.duplicatesSkipped).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(prismaMock.state.messages.length).toBe(2);
    expect(prismaMock.state.conversations.size).toBe(1);
  });
});

describe("pollFacebookCommentsForWorkspace — idempotency", () => {
  it("re-polling the same comments yields 0 created, 2 duplicates", async () => {
    prismaMock = makePrismaMock({
      connection: fbConnectionFixture(),
      drafts: [fbDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [fbCommentFixture("c1"), fbCommentFixture("c2")],
        paging: {},
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });
    expect(first.messagesCreated).toBe(2);

    const second = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });
    expect(second.messagesCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
    expect(prismaMock.state.messages.length).toBe(2);
  });
});

describe("pollFacebookCommentsForWorkspace — echo guard", () => {
  it("skips comments whose from.id equals the Page id (ECHO_FROM_PAGE)", async () => {
    prismaMock = makePrismaMock({
      connection: fbConnectionFixture(),
      drafts: [fbDraftFixture()],
    });
    const echoComment = fbCommentFixture("c_echo", {
      from: { id: FB_PAGE_ID, name: "Self" },
    });
    const realComment = fbCommentFixture("c_real");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [echoComment, realComment], paging: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.commentsFetched).toBe(2);
    expect(summary.messagesCreated).toBe(1);
    expect(summary.errors.some((e) => e.message === "ECHO_FROM_PAGE")).toBe(true);
    expect(prismaMock.state.messages.length).toBe(1);
  });
});

describe("pollFacebookCommentsForWorkspace — missing required scope", () => {
  it("skips the connection with MISSING_REQUIRED_SCOPE when a scope is absent", async () => {
    prismaMock = makePrismaMock({
      connection: fbConnectionFixture({
        // Drop pages_read_user_content — only pages_read_engagement remains.
        scopes: ["pages_read_engagement", "pages_manage_engagement"],
      }),
      drafts: [fbDraftFixture()],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.postsChecked).toBe(0);
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(summary.errors[0].message).toContain("MISSING_REQUIRED_SCOPE");
    expect(summary.errors[0].message).toContain("pages_read_user_content");
  });
});

describe("pollFacebookCommentsForWorkspace — error classification", () => {
  it("401 from Graph flips connection to NEEDS_RECONNECT and bails", async () => {
    const conn = fbConnectionFixture();
    prismaMock = makePrismaMock({
      connection: conn,
      drafts: [fbDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid OAuth access token" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.errors.some((e) => e.message.startsWith("AUTH_FAILED:401"))).toBe(true);
    expect(prismaMock.state.connectionUpdates).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_RECONNECT" }),
      }),
    );
  });

  it("403 from Graph also flips connection to NEEDS_RECONNECT", async () => {
    const conn = fbConnectionFixture();
    prismaMock = makePrismaMock({
      connection: conn,
      drafts: [fbDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "Permissions error" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });
    expect(prismaMock.state.connectionUpdates).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_RECONNECT" }),
      }),
    );
    expect(summary.errors.some((e) => e.message.startsWith("AUTH_FAILED:403"))).toBe(true);
  });

  it("5xx from Graph is transient — error logged, no status change", async () => {
    prismaMock = makePrismaMock({
      connection: fbConnectionFixture(),
      drafts: [fbDraftFixture()],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: "Service Unavailable" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.errors.some((e) => e.message.startsWith("TRANSIENT:503"))).toBe(true);
    // The only update should be lastValidatedAt — no status change.
    const statusUpdates = prismaMock.state.connectionUpdates.filter((u) => u.data?.status);
    expect(statusUpdates).toEqual([]);
  });

  it("404 on a post is non-fatal — continues with the rest", async () => {
    prismaMock = makePrismaMock({
      connection: fbConnectionFixture(),
      drafts: [
        fbDraftFixture({ id: "d1", externalPostId: "fb_post_a" }),
        fbDraftFixture({ id: "d2", externalPostId: "fb_post_b" }),
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
        json: async () => ({ data: [fbCommentFixture("c1")], paging: {} }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });

    expect(summary.postsChecked).toBe(2);
    expect(summary.messagesCreated).toBe(1);
    expect(summary.errors.some((e) => e.message.startsWith("POST_NOT_FOUND:404"))).toBe(true);
  });
});

describe("pollFacebookCommentsForWorkspace — pagination cap", () => {
  it("stops at 5 pages even if `next` cursor remains", async () => {
    prismaMock = makePrismaMock({
      connection: fbConnectionFixture(),
      drafts: [fbDraftFixture()],
    });
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          // unique ids per page so the helper doesn't dedupe them
          data: [fbCommentFixture(`page${callCount}_c1`)],
          paging: {
            cursors: { after: `cursor-${callCount}` },
            next: `https://graph.facebook.com/v19.0/${POST_ID}/comments?after=cursor-${callCount}`,
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(summary.commentsFetched).toBe(5);
    expect(summary.messagesCreated).toBe(5);
  });
});

describe("pollFacebookCommentsForWorkspace — no connection", () => {
  it("returns an error when the workspace has no FACEBOOK connection", async () => {
    prismaMock = makePrismaMock({ connection: null, drafts: [] });
    const summary = await svc.pollFacebookCommentsForWorkspace({ clientId: CLIENT_A });
    expect(summary.errors.some((e) => e.message === "NO_FACEBOOK_CONNECTION")).toBe(true);
    expect(summary.postsChecked).toBe(0);
  });
});
