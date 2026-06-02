// Shared FB/IG comment ingestion — polling-friendly persistence
// layer extracted from the now-removed Meta webhook receiver.
//
// Covers:
//   - upsertExternalCommentMessage creates Contact + Conversation
//     + Message with the expected shape for both providers.
//   - Idempotency: same comment id arriving twice returns
//     status: "duplicate" without writing a second Message.
//   - Multiple comments on the SAME post collapse into ONE
//     Conversation (one thread per post).
//   - Spam-marked conversations skip writing but report status
//     "skipped" with a reason.
//   - findConnectionForAccount returns the most-recently-updated
//     connection when multiple workspaces share an account.
//   - findOrCreateMetaContact stores externalIds.<PROVIDER> for
//     dedupe on the next call.
//   - Defensive guards: missing commentId, unsupported provider.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const {
  upsertExternalCommentMessage,
  findConnectionForAccount,
  findOrCreateMetaContact,
} = await import("../domains/inbox/inbox.metaCommentIngestion.service.js");

const CLIENT_ID = "client-meta-1";
const FB_PAGE_ID = "fb-page-100";
const IG_USER_ID = "ig-user-200";

function createPrismaMock(opts = {}) {
  const conversations = new Map();
  const contacts = new Map();
  const messages = [];
  const channelConnections = new Map();
  if (!opts.noConnections) {
    channelConnections.set(`FACEBOOK:${FB_PAGE_ID}`, [
      {
        id: "conn-fb",
        clientId: CLIENT_ID,
        channel: "FACEBOOK",
        externalAccountId: FB_PAGE_ID,
        status: "CONNECTED",
        scopes: ["pages_manage_posts", "pages_read_engagement"],
        updatedAt: new Date("2026-05-30T00:00:00Z"),
      },
    ]);
    channelConnections.set(`INSTAGRAM:${IG_USER_ID}`, [
      {
        id: "conn-ig",
        clientId: CLIENT_ID,
        channel: "INSTAGRAM",
        externalAccountId: IG_USER_ID,
        status: "CONNECTED",
        scopes: [
          "instagram_business_basic",
          "instagram_business_manage_comments",
        ],
        updatedAt: new Date("2026-05-30T00:00:00Z"),
      },
    ]);
  }
  if (opts.extraConnections) {
    for (const [key, conn] of Object.entries(opts.extraConnections)) {
      channelConnections.set(key, conn);
    }
  }
  let convCounter = 0;
  let contactCounter = 0;
  let messageCounter = 0;
  return {
    state: { conversations, contacts, messages, channelConnections },
    channelConnection: {
      findMany: vi.fn(async ({ where, orderBy }) => {
        const key = `${where.channel}:${where.externalAccountId}`;
        const rows = channelConnections.get(key) ?? [];
        let filtered = rows.filter((r) => !where.status || r.status === where.status);
        if (orderBy?.updatedAt === "desc") {
          filtered = [...filtered].sort(
            (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
          );
        }
        return filtered;
      }),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        if (!where.externalMessageId) return null;
        const m = messages.find(
          (msg) => msg.externalMessageId === where.externalMessageId,
        );
        if (!m) return null;
        const conv = conversations.get(m.conversationId);
        if (where.conversation?.clientId && conv?.clientId !== where.conversation.clientId)
          return null;
        if (where.conversation?.provider && conv?.provider !== where.conversation.provider)
          return null;
        return { id: m.id, conversationId: m.conversationId };
      }),
      create: vi.fn(async ({ data }) => {
        const id = `msg-${++messageCounter}`;
        const row = {
          id,
          createdAt: data.createdAt instanceof Date ? data.createdAt : new Date(),
          ...data,
        };
        messages.push(row);
        return row;
      }),
    },
    conversation: {
      findFirst: vi.fn(async ({ where }) => {
        for (const c of conversations.values()) {
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
        const id = `conv-${++convCounter}`;
        const row = { id, ...data };
        conversations.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = conversations.get(where.id);
        const next = { ...row, ...data };
        conversations.set(where.id, next);
        return next;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }) => {
        for (const c of contacts.values()) {
          if (where.clientId && c.clientId !== where.clientId) continue;
          if (where.enrichmentJson?.path) {
            const [head, sub] = where.enrichmentJson.path;
            const target = where.enrichmentJson.equals;
            const val = c.enrichmentJson?.[head]?.[sub];
            if (val === target) return c;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `contact-${++contactCounter}`;
        const row = { id, ...data };
        contacts.set(id, row);
        return row;
      }),
    },
  };
}

beforeEach(() => {
  prismaMock = createPrismaMock();
});

function fbCommentArgs(overrides = {}) {
  return {
    clientId: CLIENT_ID,
    provider: "FACEBOOK",
    externalAccountId: FB_PAGE_ID,
    commentId: "fb_comment_777",
    parentPostId: "fb_post_999",
    parentCommentId: null,
    body: "How much is this home?",
    fromId: "fb_user_555",
    fromName: "Daniel",
    permalink: "https://facebook.com/p/999/comment/777",
    createdAtRaw: "2026-05-15T10:00:00+0000",
    rawValue: {
      comment_id: "fb_comment_777",
      post_id: "fb_post_999",
      from: { id: "fb_user_555", name: "Daniel" },
      permalink_url: "https://facebook.com/p/999/comment/777",
      created_time: "2026-05-15T10:00:00+0000",
    },
    ...overrides,
  };
}

function igCommentArgs(overrides = {}) {
  return {
    clientId: CLIENT_ID,
    provider: "INSTAGRAM",
    externalAccountId: IG_USER_ID,
    commentId: "ig_comment_42",
    parentPostId: "ig_media_1",
    parentCommentId: null,
    body: "Love this listing!",
    fromId: "ig_user_42",
    fromName: "daniel",
    permalink: "https://instagram.com/p/abc",
    createdAtRaw: "2026-05-15T11:00:00+0000",
    rawValue: {
      id: "ig_comment_42",
      from: { id: "ig_user_42", username: "daniel" },
      media: { id: "ig_media_1", permalink: "https://instagram.com/p/abc" },
      created_time: "2026-05-15T11:00:00+0000",
    },
    ...overrides,
  };
}

// ── Facebook ───────────────────────────────────────────────────────────

describe("upsertExternalCommentMessage — Facebook Page comments", () => {
  it("creates Conversation + Message with provider=FACEBOOK, visibility=PUBLIC", async () => {
    const result = await upsertExternalCommentMessage(fbCommentArgs());
    expect(result.status).toBe("created");
    expect(prismaMock.state.conversations.size).toBe(1);
    const conv = [...prismaMock.state.conversations.values()][0];
    expect(conv.clientId).toBe(CLIENT_ID);
    expect(conv.provider).toBe("FACEBOOK");
    expect(conv.sourceType).toBe("SOCIAL");
    expect(conv.externalThreadId).toBe("fb_post_999");
    const msg = prismaMock.state.messages[0];
    expect(msg.body).toBe("How much is this home?");
    expect(msg.party).toBe("CONTACT");
    expect(msg.visibility).toBe("PUBLIC");
    expect(msg.externalMessageId).toBe("fb_comment_777");
    expect(msg.providerMessageId).toBe("fb_comment_777");
    expect(msg.sourceUrl).toMatch(/facebook\.com/);
  });

  it("creates a Contact identified by the Meta user id (no email/phone)", async () => {
    await upsertExternalCommentMessage(fbCommentArgs());
    expect(prismaMock.state.contacts.size).toBe(1);
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
    expect(contact.name).toBe("Daniel");
    expect(contact.enrichmentJson?.externalIds?.FACEBOOK).toBe("fb_user_555");
    expect(contact.firstSeenVia).toBe("SOCIAL");
  });

  it("is idempotent on comment id (second upsert → duplicate, no second Message)", async () => {
    const r1 = await upsertExternalCommentMessage(fbCommentArgs());
    expect(r1.status).toBe("created");
    const r2 = await upsertExternalCommentMessage(fbCommentArgs());
    expect(r2.status).toBe("duplicate");
    expect(r2.messageId).toBe(r1.messageId);
    expect(prismaMock.state.messages.length).toBe(1);
  });

  it("groups multiple comments on the SAME post into one Conversation", async () => {
    await upsertExternalCommentMessage(fbCommentArgs());
    await upsertExternalCommentMessage(
      fbCommentArgs({
        commentId: "fb_comment_888",
        fromId: "fb_user_666",
        fromName: "Other",
      }),
    );
    expect(prismaMock.state.conversations.size).toBe(1);
    expect(prismaMock.state.messages.length).toBe(2);
  });

  it("marks status=skipped CONVERSATION_SPAM when the existing conv is spam-flagged", async () => {
    await upsertExternalCommentMessage(fbCommentArgs());
    // Mutate the existing conversation to spam state.
    const conv = [...prismaMock.state.conversations.values()][0];
    conv.spam = true;
    const r2 = await upsertExternalCommentMessage(
      fbCommentArgs({ commentId: "fb_comment_888", fromId: "fb_user_666" }),
    );
    expect(r2.status).toBe("skipped");
    expect(r2.reason).toBe("CONVERSATION_SPAM");
    expect(prismaMock.state.messages.length).toBe(1);
  });

  it("returns MISSING_COMMENT_ID when commentId is empty", async () => {
    const r = await upsertExternalCommentMessage(fbCommentArgs({ commentId: "" }));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("MISSING_COMMENT_ID");
  });

  it("returns MISSING_FROM_ID when fromId is absent", async () => {
    const r = await upsertExternalCommentMessage(fbCommentArgs({ fromId: null }));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("MISSING_FROM_ID");
  });
});

// ── Instagram ──────────────────────────────────────────────────────────

describe("upsertExternalCommentMessage — Instagram comments", () => {
  it("creates Conversation+Message with provider=INSTAGRAM, visibility=PUBLIC", async () => {
    await upsertExternalCommentMessage(igCommentArgs());
    const conv = [...prismaMock.state.conversations.values()][0];
    expect(conv.provider).toBe("INSTAGRAM");
    expect(conv.externalThreadId).toBe("ig_media_1");
    const msg = prismaMock.state.messages[0];
    expect(msg.visibility).toBe("PUBLIC");
    expect(msg.externalMessageId).toBe("ig_comment_42");
    expect(msg.sourceUrl).toMatch(/instagram\.com/);
  });

  it("preserves the IG @username as the contact name when present", async () => {
    await upsertExternalCommentMessage(igCommentArgs());
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.name).toBe("daniel");
    expect(contact.enrichmentJson?.externalIds?.INSTAGRAM).toBe("ig_user_42");
  });
});

// ── Defensive paths ────────────────────────────────────────────────────

describe("upsertExternalCommentMessage — defensive paths", () => {
  it("rejects unsupported providers", async () => {
    const r = await upsertExternalCommentMessage(
      fbCommentArgs({ provider: "TIKTOK" }),
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/UNSUPPORTED_PROVIDER/);
  });

  it("rejects calls with no clientId", async () => {
    const r = await upsertExternalCommentMessage(fbCommentArgs({ clientId: "" }));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("MISSING_CLIENT_ID");
  });
});

// ── findConnectionForAccount ───────────────────────────────────────────

describe("findConnectionForAccount", () => {
  it("returns null when the externalAccountId is missing", async () => {
    const r = await findConnectionForAccount({
      channel: "FACEBOOK",
      externalAccountId: null,
    });
    expect(r).toBeNull();
  });

  it("returns null when no workspace has the account connected", async () => {
    prismaMock = createPrismaMock({ noConnections: true });
    const r = await findConnectionForAccount({
      channel: "FACEBOOK",
      externalAccountId: FB_PAGE_ID,
    });
    expect(r).toBeNull();
  });

  it("returns the single matching connection", async () => {
    const r = await findConnectionForAccount({
      channel: "FACEBOOK",
      externalAccountId: FB_PAGE_ID,
    });
    expect(r?.clientId).toBe(CLIENT_ID);
  });

  it("returns the most-recently-updated connection when multiple match", async () => {
    prismaMock = createPrismaMock({
      extraConnections: {
        [`FACEBOOK:${FB_PAGE_ID}`]: [
          {
            id: "conn-fb-old",
            clientId: "client-old",
            channel: "FACEBOOK",
            externalAccountId: FB_PAGE_ID,
            status: "CONNECTED",
            scopes: [],
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            id: "conn-fb-new",
            clientId: "client-new",
            channel: "FACEBOOK",
            externalAccountId: FB_PAGE_ID,
            status: "CONNECTED",
            scopes: [],
            updatedAt: new Date("2026-05-30T00:00:00Z"),
          },
        ],
      },
    });
    const r = await findConnectionForAccount({
      channel: "FACEBOOK",
      externalAccountId: FB_PAGE_ID,
    });
    expect(r?.clientId).toBe("client-new");
  });
});

// ── findOrCreateMetaContact ────────────────────────────────────────────

describe("findOrCreateMetaContact", () => {
  it("creates a Contact with the externalIds.<PROVIDER> set", async () => {
    const c = await findOrCreateMetaContact({
      clientId: CLIENT_ID,
      provider: "INSTAGRAM",
      externalUserId: "ig_user_111",
      displayName: "ada",
    });
    expect(c.name).toBe("ada");
    expect(c.enrichmentJson?.externalIds?.INSTAGRAM).toBe("ig_user_111");
  });

  it("returns the existing Contact on a second call with the same externalUserId", async () => {
    const a = await findOrCreateMetaContact({
      clientId: CLIENT_ID,
      provider: "INSTAGRAM",
      externalUserId: "ig_user_111",
      displayName: "ada",
    });
    const b = await findOrCreateMetaContact({
      clientId: CLIENT_ID,
      provider: "INSTAGRAM",
      externalUserId: "ig_user_111",
      displayName: "ada",
    });
    expect(b.id).toBe(a.id);
    expect(prismaMock.state.contacts.size).toBe(1);
  });
});
