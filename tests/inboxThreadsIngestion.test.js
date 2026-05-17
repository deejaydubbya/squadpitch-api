// Threads reply ingestion — persistence layer only (no HTTP fetch;
// no Graph API). Pins the same idempotency + thread-collapse +
// own-author guard contracts the poller relies on.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { ingestThreadsReply } = await import(
  "../domains/inbox/inbox.threads.ingestion.service.js"
);

const CLIENT_ID = "client-th-1";
const TH_USER_ID = "100100";
const POST_ID = "ti_post_001";
const REPLY_ID = "ti_reply_001";

function createPrismaMock({ noConnection = false } = {}) {
  const conversations = new Map();
  const contacts = new Map();
  const messages = [];
  const connections = new Map();
  if (!noConnection) {
    connections.set(`THREADS:${TH_USER_ID}`, {
      id: "conn-th",
      clientId: CLIENT_ID,
      channel: "THREADS",
      externalAccountId: TH_USER_ID,
      status: "CONNECTED",
      scopes: ["threads_basic", "threads_read_replies"],
      updatedAt: new Date(),
    });
  }
  let convCounter = 0;
  let contactCounter = 0;
  let messageCounter = 0;
  return {
    state: { conversations, contacts, messages, connections },
    channelConnection: {
      findMany: vi.fn(async ({ where }) => {
        const key = `${where.channel}:${where.externalAccountId}`;
        const row = connections.get(key);
        if (!row) return [];
        if (where.status && row.status !== where.status) return [];
        return [row];
      }),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        if (!where.externalMessageId) return null;
        const m = messages.find((x) => x.externalMessageId === where.externalMessageId);
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
        const row = { id, createdAt: data.createdAt instanceof Date ? data.createdAt : new Date(), ...data };
        messages.push(row);
        return row;
      }),
    },
    conversation: {
      findFirst: vi.fn(async ({ where }) => {
        for (const conv of conversations.values()) {
          if (where.clientId && conv.clientId !== where.clientId) continue;
          if (where.provider && conv.provider !== where.provider) continue;
          if (where.externalThreadId && conv.externalThreadId !== where.externalThreadId)
            continue;
          return { id: conv.id };
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
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }) => {
        for (const c of contacts.values()) {
          if (where.clientId && c.clientId !== where.clientId) continue;
          if (where.enrichmentJson?.path) {
            const [head, sub] = where.enrichmentJson.path;
            if (c.enrichmentJson?.[head]?.[sub] === where.enrichmentJson.equals) return c;
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

function makeReply(overrides = {}) {
  return {
    threadsUserId: TH_USER_ID,
    postId: POST_ID,
    postTitle: "Spring open house this Saturday",
    replyId: REPLY_ID,
    parentId: null,
    text: "Is parking included?",
    author: {
      userId: "200200",
      username: "danielv",
    },
    timestamp: "2026-05-16T10:00:00Z",
    permalink: "https://www.threads.net/@danielv/post/ti_reply_001",
    ...overrides,
  };
}

describe("ingestThreadsReply — happy path", () => {
  it("creates a Conversation with provider=THREADS, sourceType=SOCIAL_COMMENT, visibility=PUBLIC", async () => {
    const result = await ingestThreadsReply(makeReply());
    expect(result.status).toBe("created");
    const conv = [...prismaMock.state.conversations.values()][0];
    expect(conv.provider).toBe("THREADS");
    expect(conv.sourceType).toBe("SOCIAL_COMMENT");
    expect(conv.externalThreadId).toContain(POST_ID);
    const msg = prismaMock.state.messages[0];
    expect(msg.visibility).toBe("PUBLIC");
    expect(msg.externalMessageId).toBe(REPLY_ID);
    expect(msg.sourceUrl).toMatch(/threads\.net/);
  });

  it("renders the post title in the body so the Inbox preview has context", async () => {
    await ingestThreadsReply(makeReply());
    const msg = prismaMock.state.messages[0];
    expect(msg.body).toContain("Spring open house this Saturday");
    expect(msg.body).toContain("Is parking included?");
  });

  it("labels a nested reply as 'Nested reply on'", async () => {
    await ingestThreadsReply(
      makeReply({
        replyId: "ti_nested_001",
        parentId: "ti_other_reply_001",
        text: "Same question here.",
      }),
    );
    const msg = prismaMock.state.messages[0];
    expect(msg.body).toContain("Nested reply on");
  });

  it("creates a Contact identified by author.userId (no email/phone)", async () => {
    await ingestThreadsReply(makeReply());
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
    expect(contact.name).toBe("@danielv");
    expect(contact.enrichmentJson.externalIds.THREADS).toBe("200200");
  });
});

describe("ingestThreadsReply — idempotency + collapse", () => {
  it("returns duplicate on repeated call with same reply id", async () => {
    const r1 = await ingestThreadsReply(makeReply());
    expect(r1.status).toBe("created");
    const r2 = await ingestThreadsReply(makeReply());
    expect(r2.status).toBe("duplicate");
    expect(prismaMock.state.messages.length).toBe(1);
  });

  it("collapses a second reply from the same author on the same post", async () => {
    await ingestThreadsReply(makeReply());
    await ingestThreadsReply(
      makeReply({ replyId: "ti_reply_002", text: "Also, what time?" }),
    );
    expect(prismaMock.state.conversations.size).toBe(1);
    expect(prismaMock.state.messages.length).toBe(2);
  });

  it("creates a separate Conversation for a different author on the same post", async () => {
    await ingestThreadsReply(makeReply());
    await ingestThreadsReply(
      makeReply({
        replyId: "ti_reply_003",
        author: { userId: "300300", username: "otherv" },
      }),
    );
    expect(prismaMock.state.conversations.size).toBe(2);
  });
});

describe("ingestThreadsReply — skip cases", () => {
  it("returns UNKNOWN_ACCOUNT when no ChannelConnection matches the threads user", async () => {
    prismaMock = createPrismaMock({ noConnection: true });
    const result = await ingestThreadsReply(makeReply());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("UNKNOWN_ACCOUNT");
  });

  it("skips replies authored by the connected Threads user (own-author guard)", async () => {
    const result = await ingestThreadsReply(
      makeReply({
        author: { userId: TH_USER_ID, username: "us" },
      }),
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("OWN_AUTHOR");
    expect(prismaMock.state.messages.length).toBe(0);
  });

  it("returns skipped on missing user / post / reply ids", async () => {
    expect(
      (await ingestThreadsReply(makeReply({ threadsUserId: null }))).reason,
    ).toBe("MISSING_USER");
    expect((await ingestThreadsReply(makeReply({ postId: null }))).reason).toBe(
      "MISSING_POST",
    );
    expect(
      (await ingestThreadsReply(makeReply({ replyId: null }))).reason,
    ).toBe("MISSING_REPLY_ID");
  });
});
