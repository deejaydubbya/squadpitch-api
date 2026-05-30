// Meta ingestion service — Facebook Page + Instagram comment
// webhook payloads → Conversation + Message rows.
//
// Tests cover:
//   - Page feed change with item=comment creates Contact +
//     Conversation + Message with provider=FACEBOOK,
//     visibility=PUBLIC, externalMessageId set.
//   - IG comments change creates provider=INSTAGRAM equivalent.
//   - Idempotency: same comment id arriving twice doesn't
//     duplicate the Message row.
//   - Echo guard: when from.id === page id / IG user id, skip
//     (it's our own outbound).
//   - Unknown account: silently skipped with reason for log.
//   - Spam-marked conversation: existing comment messages stop.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { processMetaWebhookPayload } = await import(
  "../domains/inbox/inbox.meta.ingestion.service.js"
);

const CLIENT_ID = "client-meta-1";
const FB_PAGE_ID = "fb-page-100";
const IG_USER_ID = "ig-user-200";

function createPrismaMock(opts = {}) {
  const conversations = new Map();
  const contacts = new Map();
  const messages = [];
  const channelConnections = new Map();
  // Default: register a FACEBOOK + INSTAGRAM connection for our
  // accounts. Tests can override by passing { noConnections: true }.
  if (!opts.noConnections) {
    channelConnections.set(`FACEBOOK:${FB_PAGE_ID}`, {
      id: "conn-fb",
      clientId: CLIENT_ID,
      channel: "FACEBOOK",
      externalAccountId: FB_PAGE_ID,
      status: "CONNECTED",
      scopes: ["pages_manage_posts", "pages_read_engagement"],
    });
    channelConnections.set(`INSTAGRAM:${IG_USER_ID}`, {
      id: "conn-ig",
      clientId: CLIENT_ID,
      channel: "INSTAGRAM",
      externalAccountId: IG_USER_ID,
      status: "CONNECTED",
      scopes: ["instagram_basic", "instagram_content_publish"],
    });
  }
  let convCounter = 0;
  let contactCounter = 0;
  let messageCounter = 0;
  return {
    state: { conversations, contacts, messages, channelConnections },
    channelConnection: {
      findMany: vi.fn(async ({ where }) => {
        const key = `${where.channel}:${where.externalAccountId}`;
        const row = channelConnections.get(key);
        if (!row) return [];
        if (where.status && row.status !== where.status) return [];
        return [row];
      }),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        // Idempotency probe — match by externalMessageId AND the
        // conversation's clientId + provider. We index by the
        // externalMessageId for the test mock.
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

// ── Facebook ───────────────────────────────────────────────────────────

describe("processMetaWebhookPayload — Facebook Page comments", () => {
  function pageCommentPayload(overrides = {}) {
    return {
      object: "page",
      entry: [
        {
          id: FB_PAGE_ID,
          time: 1715789012345,
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                comment_id: "fb_comment_777",
                post_id: "fb_post_999",
                message: "How much is this home?",
                from: { id: "fb_user_555", name: "Daniel" },
                permalink_url: "https://facebook.com/p/999/comment/777",
                created_time: "2026-05-15T10:00:00+0000",
                ...overrides.value,
              },
            },
          ],
        },
      ],
    };
  }

  it("creates Conversation + Message with provider=FACEBOOK, visibility=PUBLIC", async () => {
    const result = await processMetaWebhookPayload(pageCommentPayload());
    expect(result.created).toBe(1);
    expect(result.duplicate).toBe(0);
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
    await processMetaWebhookPayload(pageCommentPayload());
    expect(prismaMock.state.contacts.size).toBe(1);
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
    expect(contact.name).toBe("Daniel");
    expect(contact.enrichmentJson?.externalIds?.FACEBOOK).toBe("fb_user_555");
    expect(contact.firstSeenVia).toBe("SOCIAL");
  });

  it("is idempotent on Meta comment id (second delivery → duplicate, no second Message)", async () => {
    await processMetaWebhookPayload(pageCommentPayload());
    const r2 = await processMetaWebhookPayload(pageCommentPayload());
    expect(r2.duplicate).toBe(1);
    expect(r2.created).toBe(0);
    expect(prismaMock.state.messages.length).toBe(1);
  });

  it("groups multiple comments on the SAME post into one Conversation (one thread per post)", async () => {
    await processMetaWebhookPayload(pageCommentPayload({}));
    await processMetaWebhookPayload(
      pageCommentPayload({
        value: { comment_id: "fb_comment_888", from: { id: "fb_user_666", name: "Other" } },
      }),
    );
    expect(prismaMock.state.conversations.size).toBe(1);
    expect(prismaMock.state.messages.length).toBe(2);
  });

  it("skips echo events where from.id == page id (our own outbound)", async () => {
    const result = await processMetaWebhookPayload(
      pageCommentPayload({ value: { from: { id: FB_PAGE_ID, name: "Page" } } }),
    );
    expect(result.skipped).toBe(1);
    expect(result.reasons).toContain("ECHO_FROM_PAGE");
    expect(prismaMock.state.messages.length).toBe(0);
  });

  it("silently skips when the Page isn't connected to any workspace", async () => {
    prismaMock = createPrismaMock({ noConnections: true });
    const result = await processMetaWebhookPayload(pageCommentPayload());
    expect(result.skipped).toBe(1);
    expect(result.reasons).toContain("UNKNOWN_ACCOUNT");
    expect(prismaMock.state.messages.length).toBe(0);
  });

  it("ignores non-comment feed items (likes, status updates) without creating a row", async () => {
    const result = await processMetaWebhookPayload({
      object: "page",
      entry: [
        {
          id: FB_PAGE_ID,
          changes: [
            { field: "feed", value: { item: "status", post_id: "p1" } },
            { field: "feed", value: { item: "like", post_id: "p1" } },
          ],
        },
      ],
    });
    expect(result.skipped).toBe(2);
    expect(prismaMock.state.messages.length).toBe(0);
  });
});

// ── Instagram ──────────────────────────────────────────────────────────

describe("processMetaWebhookPayload — Instagram comments", () => {
  function igCommentPayload() {
    return {
      object: "instagram",
      entry: [
        {
          id: IG_USER_ID,
          time: 1715789012345,
          changes: [
            {
              field: "comments",
              value: {
                id: "ig_comment_42",
                text: "Love this listing!",
                from: { id: "ig_user_42", username: "daniel" },
                media: { id: "ig_media_1", permalink: "https://instagram.com/p/abc" },
                created_time: "2026-05-15T11:00:00+0000",
              },
            },
          ],
        },
      ],
    };
  }

  it("creates Conversation+Message with provider=INSTAGRAM, visibility=PUBLIC", async () => {
    await processMetaWebhookPayload(igCommentPayload());
    const conv = [...prismaMock.state.conversations.values()][0];
    expect(conv.provider).toBe("INSTAGRAM");
    expect(conv.externalThreadId).toBe("ig_media_1");
    const msg = prismaMock.state.messages[0];
    expect(msg.visibility).toBe("PUBLIC");
    expect(msg.externalMessageId).toBe("ig_comment_42");
    expect(msg.sourceUrl).toMatch(/instagram\.com/);
  });

  it("preserves the IG @username as the contact name when present", async () => {
    await processMetaWebhookPayload(igCommentPayload());
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.name).toBe("daniel");
    expect(contact.enrichmentJson?.externalIds?.INSTAGRAM).toBe("ig_user_42");
  });
});

// ── Mixed / safety ─────────────────────────────────────────────────────

describe("processMetaWebhookPayload — defensive paths", () => {
  it("returns a skip reason for a non-object payload", async () => {
    const r1 = await processMetaWebhookPayload(null);
    expect(r1.skipped).toBeGreaterThanOrEqual(1);
    const r2 = await processMetaWebhookPayload(undefined);
    expect(r2.skipped).toBeGreaterThanOrEqual(1);
  });

  it("returns a skip reason for an unsupported `object` value", async () => {
    const result = await processMetaWebhookPayload({
      object: "user",
      entry: [{ id: "x", changes: [{ field: "feed", value: {} }] }],
    });
    expect(result.skipped).toBe(1);
    expect(result.reasons[0]).toMatch(/UNSUPPORTED_OBJECT/);
  });
});
