// Inbox tenant-isolation regression.
//
// Every Inbox service helper takes a clientId and must filter every
// query by it. The route layer additionally runs requireClientOwner,
// but the service-level scope is defense in depth — if a future route
// forgets to gate, the service still refuses to act on another
// workspace's Conversation.
//
// This file pins that behavior with workspace-A/workspace-B fixtures
// and exercises every service entry point that takes a Conversation id.

import { describe, it, expect, vi, beforeEach } from "vitest";

let state;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return state.prisma;
  },
}));

// Stub OpenAI + usage tracking for the AI-reply isolation case.
// loadAiReplyContext is exercised end-to-end via generateAiReply.
vi.mock("../domains/studio/generation/clientOrchestrator.js", () => ({
  loadClientGenerationContext: vi.fn(async () => ({
    client: { name: "Workspace" },
    brand: null,
    voice: null,
  })),
}));

vi.mock("../domains/studio/generation/openai.provider.js", () => ({
  generateStructuredContent: vi.fn(async () => ({
    parsed: { body: "stub" },
    model: "gpt-stub",
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })),
}));

vi.mock("../domains/billing/aiUsageTracking.service.js", () => ({
  trackAiUsage: vi.fn(),
}));

const service = await import("../domains/inbox/inbox.service.js");

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

const CONV_A = {
  id: "conv-a",
  clientId: CLIENT_A,
  contactId: "contact-a",
  sourceType: "FORM",
  sourceFormSubmissionId: "sub-a",
  pageId: null,
  campaignId: null,
  status: "OPEN",
  spam: false,
  lastMessageAt: new Date("2026-05-15T09:00:00Z"),
  lastMessageFrom: "CONTACT",
  workspaceReadAt: null,
  assignedUserId: null,
  contact: {
    id: "contact-a",
    clientId: CLIENT_A,
    email: "a@example.com",
    phone: null,
    name: "Workspace A Lead",
    status: "NEW",
    tags: [],
  },
};

const CONV_B = {
  id: "conv-b",
  clientId: CLIENT_B,
  contactId: "contact-b",
  sourceType: "FORM",
  sourceFormSubmissionId: "sub-b",
  pageId: null,
  campaignId: null,
  status: "OPEN",
  spam: false,
  lastMessageAt: new Date("2026-05-15T10:00:00Z"),
  lastMessageFrom: "CONTACT",
  workspaceReadAt: null,
  assignedUserId: null,
  contact: {
    id: "contact-b",
    clientId: CLIENT_B,
    email: "b@example.com",
    phone: null,
    name: "Workspace B Lead",
    status: "NEW",
    tags: ["customer-of-b"],
  },
};

function buildPrismaMock() {
  const convs = new Map([
    [CONV_A.id, CONV_A],
    [CONV_B.id, CONV_B],
  ]);
  const notes = [];
  const messages = [
    {
      id: "msg-a-in",
      conversationId: CONV_A.id,
      party: "CONTACT",
      channel: "FORM_SUBMISSION",
      body: "Hello from workspace A",
      createdAt: new Date("2026-05-15T09:00:00Z"),
    },
    {
      id: "msg-b-in",
      conversationId: CONV_B.id,
      party: "CONTACT",
      channel: "FORM_SUBMISSION",
      body: "Hello from workspace B",
      createdAt: new Date("2026-05-15T10:00:00Z"),
    },
  ];
  const suggestions = [];

  return {
    conversation: {
      findMany: vi.fn(async ({ where }) => {
        return [...convs.values()].filter((c) => {
          if (c.clientId !== where.clientId) return false;
          if (where.status && c.status !== where.status) return false;
          if (where.spam !== undefined && c.spam !== where.spam) return false;
          return true;
        });
      }),
      findFirst: vi.fn(async ({ where }) => {
        for (const c of convs.values()) {
          if (where.id && c.id !== where.id) continue;
          if (where.clientId && c.clientId !== where.clientId) continue;
          return {
            ...c,
            // The detail handler asks for `include: { messages, notes,
            // aiReplies }` — splice them in here so the prompt
            // assembly path doesn't blow up.
            messages: messages
              .filter((m) => m.conversationId === c.id)
              .slice(0, 6)
              .sort((a, b) => a.createdAt - b.createdAt),
            notes: notes.filter((n) => n.conversationId === c.id),
            aiReplies: suggestions.filter((s) => s.conversationId === c.id),
          };
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }) => {
        const c = convs.get(where.id);
        if (!c) throw new Error("Not found");
        const next = { ...c, ...data };
        convs.set(where.id, next);
        return next;
      }),
      count: vi.fn(async ({ where }) => {
        return [...convs.values()].filter((c) => {
          if (c.clientId !== where.clientId) return false;
          if (where.status && c.status !== where.status) return false;
          if (where.spam !== undefined && c.spam !== where.spam) return false;
          if (where.lastMessageFrom && c.lastMessageFrom !== where.lastMessageFrom) return false;
          return true;
        }).length;
      }),
      fields: { lastMessageAt: "lastMessageAt" }, // prisma raw-field hack the service uses
    },
    sitePage: { findUnique: vi.fn(async () => null) },
    campaign: { findUnique: vi.fn(async () => null) },
    formSubmission: { findUnique: vi.fn(async () => null) },
    workspaceDataItem: { findUnique: vi.fn(async () => null) },
    conversationNote: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `note-${notes.length + 1}`, ...data, createdAt: new Date() };
        notes.push(row);
        return row;
      }),
    },
    message: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `msg-new-${messages.length + 1}`, ...data, createdAt: data.createdAt ?? new Date() };
        messages.push(row);
        return row;
      }),
    },
    aIReplySuggestion: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `sug-${suggestions.length + 1}`, ...data, createdAt: new Date() };
        suggestions.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    _state: { convs, notes, messages, suggestions },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("inbox tenant isolation — cross-workspace blocked", () => {
  beforeEach(() => {
    state = { prisma: buildPrismaMock() };
  });

  it("listConversations(client A) only returns workspace A's conversations", async () => {
    const result = await service.listConversations(CLIENT_A, { limit: 50 });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe(CONV_A.id);
    expect(result.conversations[0].clientId).toBe(CLIENT_A);
  });

  it("getConversation(client A, conv-B) returns null", async () => {
    const result = await service.getConversation(CLIENT_A, CONV_B.id);
    expect(result).toBeNull();
  });

  it("updateConversation(client A, conv-B) throws CONVERSATION_NOT_FOUND", async () => {
    await expect(
      service.updateConversation(CLIENT_A, CONV_B.id, { status: "CLOSED" }),
    ).rejects.toMatchObject({
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    // Confirm B's status is untouched.
    expect(state.prisma._state.convs.get(CONV_B.id).status).toBe("OPEN");
  });

  it("createNote(client A, conv-B) throws CONVERSATION_NOT_FOUND and persists no note", async () => {
    await expect(
      service.createNote(CLIENT_A, CONV_B.id, "auth0|u1", "Leaked note"),
    ).rejects.toMatchObject({
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(state.prisma._state.notes).toHaveLength(0);
  });

  it("logManualMessage(client A, conv-B) throws CONVERSATION_NOT_FOUND and persists no message", async () => {
    const before = state.prisma._state.messages.length;
    await expect(
      service.logManualMessage(CLIENT_A, CONV_B.id, "auth0|u1", {
        body: "Stolen reply",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(state.prisma._state.messages).toHaveLength(before);
  });

  it("generateAiReply(client A, conv-B) throws CONVERSATION_NOT_FOUND and persists no suggestion", async () => {
    await expect(
      service.generateAiReply(CLIENT_A, CONV_B.id, "auth0|u1"),
    ).rejects.toMatchObject({
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(state.prisma._state.suggestions).toHaveLength(0);
  });

  it("getInboxStats(client A) does not include workspace B's conversations", async () => {
    const stats = await service.getInboxStats(CLIENT_A);
    expect(stats.totalCount).toBe(1);
    expect(stats.openCount).toBe(1);
    // Switching to B yields the other one.
    const statsB = await service.getInboxStats(CLIENT_B);
    expect(statsB.totalCount).toBe(1);
    expect(statsB.openCount).toBe(1);
  });
});

describe("inbox tenant isolation — rightful owner still works", () => {
  beforeEach(() => {
    state = { prisma: buildPrismaMock() };
  });

  it("getConversation(client A, conv-A) returns the conversation with whitelisted summaries", async () => {
    const result = await service.getConversation(CLIENT_A, CONV_A.id);
    expect(result).not.toBeNull();
    expect(result.id).toBe(CONV_A.id);
    // Contact, messages, notes, aiReplies arrays are present (per
    // the include clause). Page + campaign default to null since
    // CONV_A.pageId and campaignId are unset.
    expect(result.contact.email).toBe("a@example.com");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.page).toBeNull();
    expect(result.campaign).toBeNull();
    // Decorate-unread should mark this CONTACT-last + no-read-stamp
    // conversation as unread.
    expect(result.unread).toBe(true);
  });

  it("updateConversation(client A, conv-A) flips status as requested", async () => {
    const result = await service.updateConversation(CLIENT_A, CONV_A.id, {
      status: "CLOSED",
    });
    expect(result.status).toBe("CLOSED");
  });

  it("createNote / logManualMessage / generateAiReply succeed for the rightful owner", async () => {
    const note = await service.createNote(CLIENT_A, CONV_A.id, "auth0|u1", "ok");
    expect(note).toBeTruthy();
    const msg = await service.logManualMessage(CLIENT_A, CONV_A.id, "auth0|u1", {
      body: "logged",
    });
    expect(msg.party).toBe("WORKSPACE");
    const sug = await service.generateAiReply(CLIENT_A, CONV_A.id, "auth0|u1");
    expect(sug.body).toBe("stub");
  });
});

describe("inbox stats serializer contract", () => {
  beforeEach(() => {
    state = { prisma: buildPrismaMock() };
  });

  it("returns the four documented counts (unread/open/spam/total)", async () => {
    const stats = await service.getInboxStats(CLIENT_A);
    expect(stats).toEqual(
      expect.objectContaining({
        unreadCount: expect.any(Number),
        openCount: expect.any(Number),
        spamCount: expect.any(Number),
        totalCount: expect.any(Number),
      }),
    );
  });
});
