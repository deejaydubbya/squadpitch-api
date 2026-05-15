// Inbox outbound email — first real send channel.
//
// Covers the safety contracts from prompt 09:
//   - Successful send writes a Message at SENT with the provider id.
//   - Lead with no email → 412 (no send attempted).
//   - Provider unconfigured → 412 (no send attempted).
//   - Cross-workspace conversation id → 404.
//   - AI suggestion alone does NOT auto-send (separate code path).
//   - Daily rate-limit cap blocks subsequent sends with 429.
//   - Postmark returns ErrorCode != 0 → Message flips to FAILED with 502.

import { describe, it, expect, vi, beforeEach } from "vitest";

let state;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return state.prisma;
  },
}));

// Redis-backed rate limiter — stub so the limiter is in-memory per
// test. Default behavior: allowed. Tests can override.
let rateLimitImpl = vi.fn(async () => ({
  allowed: true,
  remaining: 49,
  retryAfterSec: 0,
}));
vi.mock("../domains/sites/rateLimit.js", () => ({
  checkRateLimit: (...args) => rateLimitImpl(...args),
}));

// Env stub — we toggle these per test by mutating envOverrides.
let envOverrides = {};
vi.mock("../config/env.js", () => ({
  get env() {
    return {
      POSTMARK_SERVER_TOKEN: "test-token",
      INBOX_EMAIL_FROM: "Squadpitch Inbox <inbox@mail.squadpitch.com>",
      INBOX_EMAIL_REPLY_DOMAIN: "mail.squadpitch.com",
      POSTMARK_MESSAGE_STREAM: "outbound",
      INBOX_EMAIL_DAILY_CAP: 50,
      ...envOverrides,
    };
  },
}));

const outbound = await import("../domains/inbox/inbox.outbound.email.service.js");

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

function buildPrismaMock({ conversations, contacts, clients }) {
  const convs = new Map(conversations.map((c) => [c.id, c]));
  const contactsMap = new Map(contacts.map((c) => [c.id, c]));
  const clientsMap = new Map(clients.map((c) => [c.id, c]));
  const messages = [];
  let messageCounter = 0;
  return {
    state: { convs, contactsMap, clientsMap, messages },
    conversation: {
      findFirst: vi.fn(async ({ where }) => {
        for (const c of convs.values()) {
          if (c.id !== where.id) continue;
          if (where.clientId && c.clientId !== where.clientId) continue;
          return {
            ...c,
            contact: contactsMap.get(c.contactId) ?? null,
          };
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }) => {
        const c = convs.get(where.id);
        const next = { ...c, ...data };
        if (data?.contact?.update) {
          const contact = contactsMap.get(c.contactId);
          contactsMap.set(c.contactId, { ...contact, ...data.contact.update });
        }
        convs.set(where.id, next);
        return next;
      }),
    },
    message: {
      create: vi.fn(async ({ data }) => {
        const id = `msg-${++messageCounter}`;
        const row = { id, createdAt: new Date(), ...data };
        messages.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const idx = messages.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error("not found");
        messages[idx] = { ...messages[idx], ...data };
        return messages[idx];
      }),
    },
    client: {
      findUnique: vi.fn(async ({ where }) => clientsMap.get(where.id) ?? null),
    },
    aIReplySuggestion: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

function baseFixture() {
  return buildPrismaMock({
    conversations: [
      {
        id: "conv-a",
        clientId: CLIENT_A,
        contactId: "contact-a",
        sourceType: "FORM",
        status: "OPEN",
        spam: false,
      },
      {
        id: "conv-b",
        clientId: CLIENT_B,
        contactId: "contact-b",
        sourceType: "FORM",
        status: "OPEN",
        spam: false,
      },
      {
        id: "conv-no-email",
        clientId: CLIENT_A,
        contactId: "contact-phone-only",
        sourceType: "FORM",
        status: "OPEN",
        spam: false,
      },
      {
        id: "conv-spam",
        clientId: CLIENT_A,
        contactId: "contact-a",
        sourceType: "FORM",
        status: "OPEN",
        spam: true,
      },
    ],
    contacts: [
      { id: "contact-a", email: "alice@example.com", phone: null, status: "NEW", name: "Alice" },
      { id: "contact-b", email: "bob@example.com", phone: null, status: "NEW", name: "Bob" },
      { id: "contact-phone-only", email: null, phone: "+15551234567", status: "NEW", name: null },
    ],
    clients: [
      { id: CLIENT_A, name: "Smith Realty" },
      { id: CLIENT_B, name: "Different Workspace" },
    ],
  });
}

function stubPostmark({ ErrorCode = 0, MessageID = "stub-id", shouldThrow = false } = {}) {
  return {
    sendEmail: vi.fn(async () => {
      if (shouldThrow) throw new Error("Network timeout");
      return { ErrorCode, MessageID, Message: ErrorCode === 0 ? "OK" : "Inactive recipient" };
    }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("sendInboxEmail — success path", () => {
  beforeEach(() => {
    envOverrides = {};
    state = { prisma: baseFixture() };
    rateLimitImpl = vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterSec: 0 }));
  });

  it("persists Message at SENT with providerMessageId and stamps externalMessageId", async () => {
    const pm = stubPostmark({ MessageID: "pm-12345" });
    outbound.__setPostmarkClientForTest(pm);

    const result = await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "Thanks for reaching out!",
    });

    expect(result.deliveryStatus).toBe("SENT");
    expect(result.providerMessageId).toBe("pm-12345");
    expect(result.channel).toBe("EMAIL");
    expect(result.party).toBe("WORKSPACE");
    expect(result.externalMessageId).toMatch(/^<conv-conv-a-msg-.*@mail\.squadpitch\.com>$/);

    // The Postmark payload was constructed correctly.
    const call = pm.sendEmail.mock.calls[0][0];
    expect(call.From).toMatch(/Smith Realty \(via Squadpitch\) <inbox@mail\.squadpitch\.com>/);
    expect(call.To).toBe("alice@example.com");
    expect(call.ReplyTo).toBe("reply+conv-a@mail.squadpitch.com");
    expect(call.MessageStream).toBe("outbound");
    expect(call.Headers.find((h) => h.Name === "Message-ID")).toBeTruthy();
  });

  it("auto-promotes contact status NEW → ENGAGED after first send", async () => {
    outbound.__setPostmarkClientForTest(stubPostmark());
    await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" });
    const contact = state.prisma.state.contactsMap.get("contact-a");
    expect(contact.status).toBe("ENGAGED");
  });

  it("marks the source AI suggestion as accepted when fromSuggestionId is provided", async () => {
    outbound.__setPostmarkClientForTest(stubPostmark());
    await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "from AI",
      fromSuggestionId: "sug-1",
    });
    expect(state.prisma.aIReplySuggestion.updateMany).toHaveBeenCalled();
  });
});

describe("sendInboxEmail — capability + safety blockers", () => {
  beforeEach(() => {
    envOverrides = {};
    state = { prisma: baseFixture() };
    rateLimitImpl = vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterSec: 0 }));
    outbound.__setPostmarkClientForTest(stubPostmark());
  });

  it("throws CONVERSATION_NOT_FOUND when caller workspace doesn't own the conversation", async () => {
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-b", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 404, code: "CONVERSATION_NOT_FOUND" });
    // No Message row should have been written.
    expect(state.prisma.state.messages.length).toBe(0);
  });

  it("throws EMAIL_NOT_AVAILABLE (412) when the lead has no email", async () => {
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-no-email", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_NOT_AVAILABLE" });
    expect(state.prisma.state.messages.length).toBe(0);
  });

  it("throws EMAIL_NOT_AVAILABLE when the conversation is marked spam", async () => {
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-spam", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_NOT_AVAILABLE" });
  });

  it("throws EMAIL_NOT_CONFIGURED (412) when POSTMARK_SERVER_TOKEN is unset", async () => {
    envOverrides = { POSTMARK_SERVER_TOKEN: undefined };
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_NOT_CONFIGURED" });
  });

  it("throws EMAIL_NOT_CONFIGURED when INBOX_EMAIL_FROM is unset", async () => {
    envOverrides = { INBOX_EMAIL_FROM: undefined };
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_NOT_CONFIGURED" });
  });

  it("throws BODY_REQUIRED when body is empty", async () => {
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "   " }),
    ).rejects.toMatchObject({ status: 400, code: "BODY_REQUIRED" });
  });

  it("throws RATE_LIMITED (429) when the workspace daily cap is hit", async () => {
    rateLimitImpl = vi.fn(async () => ({
      allowed: false,
      remaining: 0,
      retryAfterSec: 12 * 3600,
    }));
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    // No send attempt — Message row not created.
    expect(state.prisma.state.messages.length).toBe(0);
  });
});

describe("sendInboxEmail — provider failure paths", () => {
  beforeEach(() => {
    envOverrides = {};
    state = { prisma: baseFixture() };
    rateLimitImpl = vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterSec: 0 }));
  });

  it("marks Message FAILED with errorReason when Postmark returns ErrorCode != 0", async () => {
    outbound.__setPostmarkClientForTest(stubPostmark({ ErrorCode: 406, MessageID: null }));
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 502, code: "PROVIDER_FAILED" });

    const msg = state.prisma.state.messages[0];
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.errorReason).toMatch(/^406:/);
  });

  it("marks Message FAILED when the Postmark client throws (network/timeout)", async () => {
    outbound.__setPostmarkClientForTest(stubPostmark({ shouldThrow: true }));
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNREACHABLE" });

    const msg = state.prisma.state.messages[0];
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.errorReason).toMatch(/Network timeout/);
  });
});

describe("emailCapabilityFor — UI-facing capability snapshot", () => {
  it("returns available=true when everything is configured", () => {
    envOverrides = {};
    const result = outbound.emailCapabilityFor({
      conversation: { spam: false },
      contact: { email: "x@example.com" },
    });
    expect(result).toEqual({ available: true, reason: null });
  });

  it("returns available=false with 'no email' reason", () => {
    envOverrides = {};
    const result = outbound.emailCapabilityFor({
      conversation: { spam: false },
      contact: { email: null },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no email address/i);
  });

  it("returns available=false with provider reason when token missing", () => {
    envOverrides = { POSTMARK_SERVER_TOKEN: undefined };
    const result = outbound.emailCapabilityFor({
      conversation: { spam: false },
      contact: { email: "x@example.com" },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });
});

describe("buildFromAddress / buildReplyToAddress / buildSubject — helpers", () => {
  it("buildFromAddress injects workspace name as 'X (via Squadpitch) <addr>'", () => {
    const env_ = { INBOX_EMAIL_FROM: "Squadpitch Inbox <inbox@mail.squadpitch.com>" };
    expect(outbound.buildFromAddress(env_, "Smith Realty")).toBe(
      "Smith Realty (via Squadpitch) <inbox@mail.squadpitch.com>",
    );
  });

  it("buildFromAddress strips angle brackets from injected client name to avoid header injection", () => {
    const env_ = { INBOX_EMAIL_FROM: "Squadpitch Inbox <inbox@mail.squadpitch.com>" };
    const result = outbound.buildFromAddress(env_, 'Evil <attacker@x.com> "');
    expect(result).not.toMatch(/<attacker@x\.com>/);
    expect(result).toMatch(/<inbox@mail\.squadpitch\.com>/);
  });

  it("buildReplyToAddress builds reply+convId@<domain>", () => {
    expect(
      outbound.buildReplyToAddress({ INBOX_EMAIL_REPLY_DOMAIN: "mail.squadpitch.com" }, "conv-123"),
    ).toBe("reply+conv-123@mail.squadpitch.com");
  });

  it("buildReplyToAddress returns null when reply domain unset", () => {
    expect(outbound.buildReplyToAddress({ INBOX_EMAIL_REPLY_DOMAIN: undefined }, "x")).toBeNull();
  });

  it("buildSubject defaults to Re: Your inquiry to <client>", () => {
    expect(outbound.buildSubject({ override: null, clientName: "Smith Realty" })).toBe(
      "Re: Your inquiry to Smith Realty",
    );
    expect(outbound.buildSubject({ override: "Custom subject", clientName: "Smith Realty" })).toBe(
      "Custom subject",
    );
  });
});

// Sanity check: the AI-suggest path does NOT call into the outbound
// email service. This is a structural test — generateAiReply lives
// in inbox.service.js and only persists an AIReplySuggestion row.
describe("AI suggest does not auto-send", () => {
  it("inbox.service.generateAiReply has no import of outbound email service", async () => {
    const fs = await import("node:fs/promises");
    const serviceSrc = await fs.readFile(
      new URL("../domains/inbox/inbox.service.js", import.meta.url),
      "utf8",
    );
    // The service may import emailCapabilityFor (for the detail
    // response) but must NEVER import sendInboxEmail. If a future
    // refactor wires them together, this catches it.
    expect(serviceSrc).not.toMatch(/\bsendInboxEmail\b/);
  });
});
