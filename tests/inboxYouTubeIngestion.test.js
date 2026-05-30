// YouTube comment ingestion — persistence layer only (no HTTP
// fetch; no Graph API). The polling worker hands normalized
// comment payloads to ingestYouTubeComment() and these tests pin
// the persistence + idempotency + thread-collapsing + tenant-
// isolation contracts that worker relies on.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { ingestYouTubeComment } = await import(
  "../domains/inbox/inbox.youtube.ingestion.service.js"
);

const CLIENT_ID = "client-yt-1";
const CHANNEL_ID = "UCabc123";
const VIDEO_ID = "dQw4w9WgXcQ";
const COMMENT_ID = "Ugxyz_top_comment_001";

function createPrismaMock({ noConnection = false } = {}) {
  const conversations = new Map();
  const contacts = new Map();
  const messages = [];
  const connections = new Map();
  if (!noConnection) {
    connections.set(`YOUTUBE:${CHANNEL_ID}`, {
      id: "conn-yt",
      clientId: CLIENT_ID,
      channel: "YOUTUBE",
      externalAccountId: CHANNEL_ID,
      status: "CONNECTED",
      scopes: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
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

function makeComment(overrides = {}) {
  return {
    channelId: CHANNEL_ID,
    videoId: VIDEO_ID,
    videoTitle: "Spring open house highlights",
    commentId: COMMENT_ID,
    parentId: null,
    text: "Beautiful house! Is it still available?",
    author: {
      channelId: "UCviewer1",
      displayName: "Daniel V.",
      profileImageUrl: "https://yt.example/pfp.jpg",
    },
    publishedAt: "2026-05-16T10:00:00Z",
    sourceUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}&lc=${COMMENT_ID}`,
    ...overrides,
  };
}

// ── Happy path ─────────────────────────────────────────────────────────

describe("ingestYouTubeComment — happy path", () => {
  it("creates a Conversation with provider=YOUTUBE, sourceType=SOCIAL_COMMENT, visibility=PUBLIC", async () => {
    const result = await ingestYouTubeComment(makeComment());
    expect(result.status).toBe("created");
    const conv = [...prismaMock.state.conversations.values()][0];
    expect(conv.clientId).toBe(CLIENT_ID);
    expect(conv.provider).toBe("YOUTUBE");
    expect(conv.sourceType).toBe("SOCIAL_COMMENT");
    expect(conv.externalThreadId).toContain(VIDEO_ID);
    const msg = prismaMock.state.messages[0];
    expect(msg.party).toBe("CONTACT");
    expect(msg.visibility).toBe("PUBLIC");
    expect(msg.externalMessageId).toBe(COMMENT_ID);
    expect(msg.providerMessageId).toBe(COMMENT_ID);
    expect(msg.sourceUrl).toMatch(/youtube\.com\/watch/);
  });

  it("renders the video title in the body so the Inbox preview has context", async () => {
    await ingestYouTubeComment(makeComment());
    const msg = prismaMock.state.messages[0];
    expect(msg.body).toContain("Spring open house highlights");
    expect(msg.body).toContain("Is it still available?");
  });

  it("labels a reply as 'Reply on' rather than 'Comment on'", async () => {
    await ingestYouTubeComment(
      makeComment({
        commentId: "Ugxyz_reply_002",
        parentId: "Ugxyz_top_001",
        text: "I had a great experience too.",
      }),
    );
    const msg = prismaMock.state.messages[0];
    expect(msg.body).toContain("Reply on");
  });

  it("creates a Contact identified by author.channelId (no email/phone surfaced)", async () => {
    await ingestYouTubeComment(makeComment());
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
    expect(contact.name).toBe("Daniel V.");
    expect(contact.firstSeenVia).toBe("SOCIAL");
    expect(contact.enrichmentJson?.externalIds?.YOUTUBE).toBe("UCviewer1");
  });

  it("synthesizes a stable id for an anonymous-looking commenter (no channelId)", async () => {
    await ingestYouTubeComment(
      makeComment({
        author: { channelId: null, displayName: "Anonymous Viewer", profileImageUrl: null },
      }),
    );
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.enrichmentJson.externalIds.YOUTUBE).toMatch(/^anon:/);
  });

  it("stores a sanitized payloadJson — no arbitrary YouTube fields echoed", async () => {
    await ingestYouTubeComment(makeComment());
    const msg = prismaMock.state.messages[0];
    expect(msg.payloadJson).toMatchObject({
      commentId: COMMENT_ID,
      videoId: VIDEO_ID,
      channelId: CHANNEL_ID,
      author: { channelId: "UCviewer1", displayName: "Daniel V." },
    });
  });
});

// ── Idempotency ────────────────────────────────────────────────────────

describe("ingestYouTubeComment — idempotency", () => {
  it("returns duplicate on a repeated call with the same comment id (no extra rows)", async () => {
    const r1 = await ingestYouTubeComment(makeComment());
    expect(r1.status).toBe("created");
    const r2 = await ingestYouTubeComment(makeComment());
    expect(r2.status).toBe("duplicate");
    expect(r2.conversationId).toBe(r1.conversationId);
    expect(r2.messageId).toBe(r1.messageId);
    expect(prismaMock.state.messages.length).toBe(1);
    expect(prismaMock.state.conversations.size).toBe(1);
  });

  it("collapses a second comment from the same author on the same video into one Conversation", async () => {
    await ingestYouTubeComment(makeComment());
    await ingestYouTubeComment(
      makeComment({
        commentId: "Ugxyz_reply_002",
        parentId: COMMENT_ID,
        text: "Also: tour available?",
      }),
    );
    expect(prismaMock.state.conversations.size).toBe(1);
    expect(prismaMock.state.messages.length).toBe(2);
  });

  it("creates a separate Conversation for a different author on the same video", async () => {
    await ingestYouTubeComment(makeComment());
    await ingestYouTubeComment(
      makeComment({
        commentId: "Ugxyz_other_001",
        author: {
          channelId: "UCviewer2",
          displayName: "Other Viewer",
          profileImageUrl: null,
        },
      }),
    );
    expect(prismaMock.state.conversations.size).toBe(2);
  });
});

// ── Tenant isolation + skip cases ─────────────────────────────────────

describe("ingestYouTubeComment — skip cases", () => {
  it("returns UNKNOWN_ACCOUNT when no ChannelConnection matches the channel id", async () => {
    prismaMock = createPrismaMock({ noConnection: true });
    const result = await ingestYouTubeComment(makeComment());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("UNKNOWN_ACCOUNT");
    expect(prismaMock.state.conversations.size).toBe(0);
  });

  it("skips comments authored by the connected channel itself (our own outbound replies)", async () => {
    const result = await ingestYouTubeComment(
      makeComment({
        author: {
          channelId: CHANNEL_ID, // we replied as the workspace channel
          displayName: "Squadpitch Demo",
          profileImageUrl: null,
        },
      }),
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("OWN_AUTHOR");
    expect(prismaMock.state.messages.length).toBe(0);
  });

  it("returns skipped on a missing channel id / video id / comment id", async () => {
    expect(
      (await ingestYouTubeComment(makeComment({ channelId: null }))).reason,
    ).toBe("MISSING_CHANNEL");
    expect((await ingestYouTubeComment(makeComment({ videoId: null }))).reason).toBe(
      "MISSING_VIDEO",
    );
    expect(
      (await ingestYouTubeComment(makeComment({ commentId: null }))).reason,
    ).toBe("MISSING_COMMENT_ID");
  });

  it("returns skipped on a null/non-object payload", async () => {
    expect((await ingestYouTubeComment(null)).status).toBe("skipped");
    expect((await ingestYouTubeComment("not an object")).status).toBe("skipped");
  });
});
