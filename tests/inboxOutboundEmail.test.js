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
      POSTMARK_INBOUND_WEBHOOK_SECRET: "test-secret",
      POSTMARK_ACCOUNT_APPROVED: true,
      POSTMARK_SENDER_VERIFIED: true,
      POSTMARK_DELIVERY_VERIFIED: true,
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
      // Used by sendInboxEmail to load the latest CONTACT message
      // for the outbound context block (party filter, desc sort) AND
      // to look up an existing Message by idempotency key (no sort).
      findFirst: vi.fn(async ({ where, orderBy }) => {
        let matches = messages.filter((m) => {
          if (where?.conversationId && m.conversationId !== where.conversationId) return false;
          if (where?.party && m.party !== where.party) return false;
          if (where?.idempotencyKey !== undefined && m.idempotencyKey !== where.idempotencyKey) return false;
          return true;
        });
        if (orderBy?.createdAt === "desc") {
          matches = matches.slice().sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );
        }
        return matches[0] ?? null;
      }),
      // Used by sendInboxEmail to gather prior EMAIL messages with
      // an RFC Message-ID, for In-Reply-To + References headers.
      findMany: vi.fn(async ({ where, orderBy, take }) => {
        let matches = messages.filter((m) => {
          if (where?.conversationId && m.conversationId !== where.conversationId) return false;
          if (where?.channel && m.channel !== where.channel) return false;
          if (where?.externalMessageId?.not === null) {
            if (m.externalMessageId == null) return false;
          }
          return true;
        });
        if (orderBy?.createdAt === "asc") {
          matches = matches.slice().sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
        }
        if (typeof take === "number") matches = matches.slice(0, take);
        return matches;
      }),
      create: vi.fn(async ({ data }) => {
        // Mirror the @@unique([conversationId, idempotencyKey])
        // constraint so race tests can rely on a real P2002 throw.
        if (data?.idempotencyKey) {
          const collision = messages.find(
            (m) =>
              m.conversationId === data.conversationId &&
              m.idempotencyKey === data.idempotencyKey,
          );
          if (collision) {
            const err = new Error(
              "Unique constraint failed on the fields: (`conversationId`,`idempotencyKey`)",
            );
            err.code = "P2002";
            err.meta = { target: ["conversationId", "idempotencyKey"] };
            throw err;
          }
        }
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
    // Outbound also looks up the source page + campaign to render
    // in the context block. Tests can seed these by extending the
    // fixture map; otherwise lookups return null.
    sitePage: {
      findUnique: vi.fn(async () => null),
    },
    campaign: {
      findUnique: vi.fn(async () => null),
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
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_RECIPIENT_MISSING" });
    expect(state.prisma.state.messages.length).toBe(0);
  });

  it("throws EMAIL_NOT_AVAILABLE when the conversation is marked spam", async () => {
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-spam", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_CONVERSATION_SPAM" });
  });

  it("throws EMAIL_NOT_CONFIGURED (412) when POSTMARK_SERVER_TOKEN is unset", async () => {
    envOverrides = { POSTMARK_SERVER_TOKEN: undefined };
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_PROVIDER_NOT_CONFIGURED" });
  });

  it("throws EMAIL_NOT_CONFIGURED when INBOX_EMAIL_FROM is unset", async () => {
    envOverrides = { INBOX_EMAIL_FROM: undefined };
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 412, code: "EMAIL_PROVIDER_NOT_CONFIGURED" });
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
    expect(msg.errorReason).toBe("postmark:RECIPIENT_INACTIVE:code=406:retryable=false");
  });

  it("marks Message FAILED when the Postmark client throws (network/timeout)", async () => {
    outbound.__setPostmarkClientForTest(stubPostmark({ shouldThrow: true }));
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNREACHABLE" });

    const msg = state.prisma.state.messages[0];
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.errorReason).toBe("postmark:PROVIDER_UNAVAILABLE:code=unknown:retryable=true");
    expect(msg.errorReason).not.toMatch(/timeout|@/i);
  });

  it("maps a Postmark 4xx with ErrorCode 412 (pending-approval) to PROVIDER_FAILED with user-actionable copy", async () => {
    // Postmark SDK throws an ApiInputError-shaped object for 4xx
    // responses. Mirror the shape we saw in prod.
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async () => {
        const e = new Error(
          "While your account is pending approval, all recipient addresses must share the same domain as the 'From' address.",
        );
        e.name = "ApiInputError";
        e.code = 412;
        e.statusCode = 422;
        throw e;
      }),
    });
    let caught;
    try {
      await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.status).toBe(502);
    expect(caught.code).toBe("PROVIDER_FAILED");
    expect(caught.postmarkErrorCode).toBe(412);
    expect(caught.message).toMatch(/sandbox/i);
    expect(caught.message).toMatch(/Postmark dashboard/);

    const msg = state.prisma.state.messages[0];
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.errorReason).toBe("postmark:ACCOUNT_APPROVAL_PENDING:code=412:retryable=false");
  });

  it("maps Postmark ErrorCode 406 (inactive recipient) to a targeted user message", async () => {
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async () => {
        const e = new Error("Inactive recipient");
        e.name = "ApiInputError";
        e.code = 406;
        e.statusCode = 422;
        throw e;
      }),
    });
    let caught;
    try {
      await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe("PROVIDER_FAILED");
    expect(caught.message).toMatch(/inactive/i);
  });
});

describe("emailCapabilityFor — UI-facing capability snapshot", () => {
  it("returns available=true when everything is configured", () => {
    envOverrides = {};
    const result = outbound.emailCapabilityFor({
      conversation: { spam: false },
      contact: { email: "x@example.com" },
    });
    expect(result.available).toBe(true);
    expect(result.canSend).toBe(true);
    expect(result.channelEligible).toBe(true);
    expect(result.recipientAvailable).toBe(true);
  });

  it("returns available=false with 'no email' reason", () => {
    envOverrides = {};
    const result = outbound.emailCapabilityFor({
      conversation: { spam: false },
      contact: { email: null },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/add an email address/i);
    expect(result.blockedCode).toBe("EMAIL_RECIPIENT_MISSING");
  });

  it("keeps normal email blocked while the dedicated canary service can persist a threaded send", async () => {
    envOverrides = { POSTMARK_DELIVERY_VERIFIED: false };
    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", { body: "hi" }),
    ).rejects.toMatchObject({
      status: 412,
      code: "EMAIL_DELIVERY_UNVERIFIED",
    });

    const pm = stubPostmark({ MessageID: "pm-canary" });
    outbound.__setPostmarkClientForTest(pm);
    const result = await outbound.sendSyntheticCanaryEmail(CLIENT_A, "conv-a", {
      body: "[SYNTHETIC CANARY] controlled verification",
      subject: "[SYNTHETIC CANARY] Postmark verification",
      idempotencyKey: ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-"),
    });
    expect(result).toMatchObject({
      deliveryStatus: "SENT",
      providerMessageId: "pm-canary",
    });
    expect(pm.sendEmail.mock.calls[0][0].ReplyTo).toBe(
      "reply+conv-a@mail.squadpitch.com",
    );
  });

  it("distinguishes account approval and sender verification", () => {
    envOverrides = { POSTMARK_ACCOUNT_APPROVED: false };
    const pending = outbound.emailCapabilityFor({ conversation: {}, contact: { email: "x@example.com" } });
    expect(pending.blockedCode).toBe("EMAIL_ACCOUNT_APPROVAL_PENDING");

    envOverrides = { POSTMARK_ACCOUNT_APPROVED: true, POSTMARK_SENDER_VERIFIED: false };
    const sender = outbound.emailCapabilityFor({ conversation: {}, contact: { email: "x@example.com" } });
    expect(sender.blockedCode).toBe("EMAIL_SENDER_UNVERIFIED");
  });

  it("sanitizes provider errors without retaining email addresses or raw text", () => {
    const safe = outbound.sanitizedProviderFailure(422, 400);
    expect(safe).toBe("postmark:SENDER_UNVERIFIED:code=422:retryable=false");
    expect(safe).not.toContain("@");
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

// ── Outbound context block (spinstr406) ────────────────────────────────

describe("outbound email context block — composeOutboundBody", () => {
  it("returns just the user reply when there's no contact message to quote", () => {
    const { text, html } = outbound.composeOutboundBody({
      userReply: "Thanks for reaching out!",
      latestContactMessage: null,
      contact: { name: "Alice", email: "alice@example.com" },
    });
    expect(text).toBe("Thanks for reaching out!");
    expect(html).toBe("Thanks for reaching out!");
    // No separator / quote marks when nothing to quote.
    expect(text).not.toContain("Original inquiry");
    expect(text).not.toContain("─");
  });

  it("includes 'Original inquiry' header + page title for FORM_SUBMISSION quotes", () => {
    const { text, html } = outbound.composeOutboundBody({
      userReply: "Happy to share details.",
      latestContactMessage: {
        channel: "FORM_SUBMISSION",
        body: "How much is the home selling for?",
        createdAt: new Date("2026-05-15T14:00:00Z"),
      },
      contact: { name: "Daniel Wardlow", email: "dwardlow@squadpitch.com" },
      sourcePage: { title: "508 King George Court", slug: "508-king-george-court" },
      sourceCampaign: null,
    });
    // Plain text version
    expect(text).toMatch(/^Happy to share details\./);
    expect(text).toContain("Original inquiry from Daniel Wardlow");
    expect(text).toContain("From page: 508 King George Court");
    expect(text).toContain("> How much is the home selling for?");
    // HTML version — proper quote-block, no script.
    expect(html).toContain("<blockquote");
    expect(html).toMatch(/Original inquiry from Daniel Wardlow/);
    expect(html).toContain("From page: 508 King George Court");
    // Quote body went through escapeHtml.
    expect(html).toMatch(/How much is the home selling for\?/);
  });

  it("includes 'On <date>, <name> wrote:' header for non-form latest CONTACT messages", () => {
    const { text } = outbound.composeOutboundBody({
      userReply: "Got it, will follow up tomorrow.",
      latestContactMessage: {
        channel: "EMAIL",
        body: "Are you available this week?",
        createdAt: new Date("2026-05-15T14:00:00Z"),
      },
      contact: { name: "Bob", email: "bob@example.com" },
    });
    expect(text).toMatch(/^Got it, will follow up tomorrow\./);
    expect(text).toMatch(/On .+, Bob wrote:/);
    expect(text).toContain("> Are you available this week?");
    // The "Original inquiry" framing is reserved for form messages —
    // it shouldn't appear here.
    expect(text).not.toContain("Original inquiry");
  });

  it("includes campaign name when source campaign is supplied", () => {
    const { text, html } = outbound.composeOutboundBody({
      userReply: "Hi!",
      latestContactMessage: {
        channel: "FORM_SUBMISSION",
        body: "Asking about your spring open house.",
        createdAt: new Date("2026-05-15T14:00:00Z"),
      },
      contact: { email: "lead@example.com" },
      sourcePage: null,
      sourceCampaign: { name: "Spring Open House Push" },
    });
    expect(text).toContain("Campaign: Spring Open House Push");
    expect(html).toContain("Campaign: Spring Open House Push");
  });

  it("HTML-escapes user-controlled values to prevent injection", () => {
    const malicious = '<script>alert("xss")</script>';
    const { html } = outbound.composeOutboundBody({
      userReply: "Hi there.",
      latestContactMessage: {
        channel: "FORM_SUBMISSION",
        body: malicious,
        createdAt: new Date("2026-05-15T14:00:00Z"),
      },
      contact: { name: malicious, email: "lead@example.com" },
      sourcePage: { title: malicious },
      sourceCampaign: { name: malicious },
    });
    // The raw script tag is NEVER present in the output.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(\"xss\")");
    // The escaped form IS present (proves the malicious text
    // landed in the body but was rendered safe).
    expect(html).toContain("&lt;script&gt;");
  });

  it("sendInboxEmail end-to-end: TextBody/HtmlBody include the latest contact message, Message.body stores ONLY user reply", async () => {
    // Reset env — previous describe blocks may have left a stub.
    envOverrides = {};
    // Seed: existing form-submission CONTACT message in the
    // conversation. The Postmark stub captures the payload we send.
    state = { prisma: baseFixture() };
    state.prisma.state.messages.push({
      id: "msg-inbound-1",
      conversationId: "conv-a",
      party: "CONTACT",
      channel: "FORM_SUBMISSION",
      body: "How much are you asking for this home?",
      createdAt: new Date("2026-05-15T14:00:00Z"),
    });
    // Pretend the conversation came from a SquadSite page.
    state.prisma.state.convs.get("conv-a").pageId = "page-1";
    state.prisma.sitePage.findUnique = vi.fn(async ({ where }) =>
      where.id === "page-1"
        ? { id: "page-1", title: "508 King George Court", slug: "508-king-george-court" }
        : null,
    );

    const captured = {};
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        Object.assign(captured, payload);
        return { ErrorCode: 0, MessageID: "stub-msg-id" };
      }),
    });

    rateLimitImpl = vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterSec: 0 }));

    const userReply = "Happy to share details — let me know a good time to call.";
    const stored = await outbound.sendInboxEmail(
      "client-a",
      "conv-a",
      "auth0|u1",
      { body: userReply },
    );

    // The Message row stored in the thread keeps ONLY the user's
    // reply — never the quoted thread.
    expect(stored.body).toBe(userReply);
    expect(stored.body).not.toContain("Original inquiry");
    expect(stored.body).not.toContain("How much are you asking");

    // The Postmark payload's TextBody DOES carry the context block.
    expect(captured.TextBody).toContain(userReply);
    expect(captured.TextBody).toContain("Original inquiry");
    expect(captured.TextBody).toContain("From page: 508 King George Court");
    expect(captured.TextBody).toContain("> How much are you asking for this home?");

    // Same for HtmlBody.
    expect(captured.HtmlBody).toContain("<blockquote");
    expect(captured.HtmlBody).toContain("How much are you asking for this home?");
    expect(captured.HtmlBody).toMatch(/Original inquiry from .*Alice/i);
  });

  it("sendInboxEmail never loads internal notes for the outbound context", async () => {
    envOverrides = {};
    state = { prisma: baseFixture() };
    // Seed: a CONTACT message AND a workspace internal note.
    state.prisma.state.messages.push({
      id: "msg-inbound-1",
      conversationId: "conv-a",
      party: "CONTACT",
      channel: "FORM_SUBMISSION",
      body: "Public question from the lead.",
      createdAt: new Date("2026-05-15T13:00:00Z"),
    });
    // Internal note — NOT a message. Stored on ConversationNote.
    // The outbound service should not query notes at all.
    const noteFindSpy = vi.fn(async () => null);
    state.prisma.conversationNote = { findFirst: noteFindSpy, findMany: noteFindSpy };

    const captured = {};
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        Object.assign(captured, payload);
        return { ErrorCode: 0, MessageID: "stub-msg-id" };
      }),
    });
    rateLimitImpl = vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterSec: 0 }));

    await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", {
      body: "Reply text",
    });

    // The outbound path should never have queried notes.
    expect(noteFindSpy).not.toHaveBeenCalled();
    // The lead's public question made it into the quote; the
    // internal-note table was never even touched.
    expect(captured.TextBody).toContain("> Public question from the lead.");
  });
});

// ── RFC threading (spinstr407) ──────────────────────────────────────────

describe("buildThreadingHeaders — pure helper", () => {
  it("returns [] when there are no prior EMAIL messages", () => {
    expect(outbound.buildThreadingHeaders([])).toEqual([]);
    expect(outbound.buildThreadingHeaders(null)).toEqual([]);
    expect(outbound.buildThreadingHeaders(undefined)).toEqual([]);
  });

  it("ignores messages without an externalMessageId", () => {
    expect(
      outbound.buildThreadingHeaders([
        { id: "m1", externalMessageId: null, createdAt: new Date("2026-05-15T10:00:00Z") },
        { id: "m2", externalMessageId: "", createdAt: new Date("2026-05-15T11:00:00Z") },
      ]),
    ).toEqual([]);
  });

  it("sets In-Reply-To to the most recent prior ID and References to the chronological chain", () => {
    const headers = outbound.buildThreadingHeaders([
      { id: "m1", externalMessageId: "<id-1@d>", createdAt: new Date("2026-05-15T10:00:00Z") },
      { id: "m2", externalMessageId: "<id-2@d>", createdAt: new Date("2026-05-15T11:00:00Z") },
      { id: "m3", externalMessageId: "<id-3@d>", createdAt: new Date("2026-05-15T12:00:00Z") },
    ]);
    const irt = headers.find((h) => h.Name === "In-Reply-To");
    const refs = headers.find((h) => h.Name === "References");
    expect(irt.Value).toBe("<id-3@d>");
    expect(refs.Value).toBe("<id-1@d> <id-2@d> <id-3@d>");
  });

  it("caps References at 25, preserving the thread root (first) and the most recent tail", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      externalMessageId: `<id-${i}@d>`,
      createdAt: new Date(`2026-05-15T10:${String(i).padStart(2, "0")}:00Z`),
    }));
    const headers = outbound.buildThreadingHeaders(many);
    const refs = headers.find((h) => h.Name === "References");
    const ids = refs.Value.split(" ");
    expect(ids.length).toBe(25);
    expect(ids[0]).toBe("<id-0@d>"); // thread root preserved
    expect(ids[ids.length - 1]).toBe("<id-39@d>"); // most recent at the tail
  });

  it("tolerates unsorted input by sorting on createdAt ascending", () => {
    const headers = outbound.buildThreadingHeaders([
      { id: "later", externalMessageId: "<later@d>", createdAt: new Date("2026-05-15T12:00:00Z") },
      { id: "earlier", externalMessageId: "<earlier@d>", createdAt: new Date("2026-05-15T10:00:00Z") },
    ]);
    const irt = headers.find((h) => h.Name === "In-Reply-To");
    const refs = headers.find((h) => h.Name === "References");
    expect(irt.Value).toBe("<later@d>");
    expect(refs.Value).toBe("<earlier@d> <later@d>");
  });
});

describe("sendInboxEmail — RFC threading headers end-to-end", () => {
  beforeEach(() => {
    envOverrides = {};
    state = { prisma: baseFixture() };
    rateLimitImpl = vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterSec: 0 }));
  });

  it("first outbound carries Message-ID but no In-Reply-To / References", async () => {
    const captured = {};
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        Object.assign(captured, payload);
        return { ErrorCode: 0, MessageID: "stub-1" };
      }),
    });

    await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", { body: "First reply" });

    const headerNames = (captured.Headers ?? []).map((h) => h.Name);
    expect(headerNames).toContain("Message-ID");
    expect(headerNames).not.toContain("In-Reply-To");
    expect(headerNames).not.toContain("References");

    // The persisted Message row carries the externalMessageId we sent.
    const persisted = state.prisma.state.messages.find((m) => m.party === "WORKSPACE");
    expect(persisted.externalMessageId).toMatch(/^<conv-conv-a-msg-.*>$/);
    expect(persisted.deliveryStatus).toBe("SENT");
  });

  it("second outbound includes In-Reply-To pointing at the prior outbound's Message-ID", async () => {
    // First send to seed a prior EMAIL message with an externalMessageId.
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async () => ({ ErrorCode: 0, MessageID: "stub-1" })),
    });
    await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", { body: "First reply" });
    const firstSent = state.prisma.state.messages.find((m) => m.party === "WORKSPACE");
    const firstRfcId = firstSent.externalMessageId;
    expect(firstRfcId).toBeTruthy();

    // Second send — capture the headers.
    const captured = {};
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        Object.assign(captured, payload);
        return { ErrorCode: 0, MessageID: "stub-2" };
      }),
    });
    await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", { body: "Following up" });

    const irt = captured.Headers.find((h) => h.Name === "In-Reply-To");
    const refs = captured.Headers.find((h) => h.Name === "References");
    expect(irt.Value).toBe(firstRfcId);
    // References should contain the prior ID (chronological order).
    expect(refs.Value.split(" ")).toContain(firstRfcId);
  });

  it("third outbound builds References from both the prior outbound AND a prior CONTACT (inbound) message", async () => {
    // Seed: prior outbound EMAIL message + prior CONTACT EMAIL message
    // (e.g. lead replied between our two sends).
    state.prisma.state.messages.push({
      id: "msg-outbound-1",
      conversationId: "conv-a",
      party: "WORKSPACE",
      channel: "EMAIL",
      body: "First",
      externalMessageId: "<conv-conv-a-msg-outbound-1@mail.squadpitch.com>",
      createdAt: new Date("2026-05-15T10:00:00Z"),
    });
    state.prisma.state.messages.push({
      id: "msg-inbound-1",
      conversationId: "conv-a",
      party: "CONTACT",
      channel: "EMAIL",
      body: "Reply from lead",
      externalMessageId: "<inbound-postmark-msg-1@postmarkapp.com>",
      createdAt: new Date("2026-05-15T11:00:00Z"),
    });

    const captured = {};
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        Object.assign(captured, payload);
        return { ErrorCode: 0, MessageID: "stub-3" };
      }),
    });
    await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", { body: "Replying back" });

    const irt = captured.Headers.find((h) => h.Name === "In-Reply-To");
    const refs = captured.Headers.find((h) => h.Name === "References");
    // In-Reply-To points at the MOST RECENT prior — which is the
    // inbound lead reply.
    expect(irt.Value).toBe("<inbound-postmark-msg-1@postmarkapp.com>");
    // References lists both in chronological order.
    expect(refs.Value).toBe(
      "<conv-conv-a-msg-outbound-1@mail.squadpitch.com> <inbound-postmark-msg-1@postmarkapp.com>",
    );
  });

  it("does not include ConversationNote or AIReplySuggestion in threading", async () => {
    // Seed: a prior EMAIL outbound + a separate non-EMAIL message
    // (FORM_SUBMISSION) + verify the latter doesn't end up in
    // threading. ConversationNotes and AI suggestions live in
    // different tables entirely, so the channel=EMAIL filter on
    // the message.findMany call is the relevant guard.
    state.prisma.state.messages.push({
      id: "msg-form",
      conversationId: "conv-a",
      party: "CONTACT",
      channel: "FORM_SUBMISSION",
      body: "Form submitted",
      // Form-submission messages don't get an RFC Message-ID, but
      // even if a bug did set one we'd want it filtered out.
      externalMessageId: "<should-not-be-used@form>",
      createdAt: new Date("2026-05-15T09:00:00Z"),
    });
    state.prisma.state.messages.push({
      id: "msg-email-1",
      conversationId: "conv-a",
      party: "WORKSPACE",
      channel: "EMAIL",
      body: "Real email",
      externalMessageId: "<real-email-1@mail.squadpitch.com>",
      createdAt: new Date("2026-05-15T10:00:00Z"),
    });

    const captured = {};
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        Object.assign(captured, payload);
        return { ErrorCode: 0, MessageID: "stub" };
      }),
    });
    await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", { body: "Reply" });

    const refs = captured.Headers.find((h) => h.Name === "References");
    expect(refs.Value).toBe("<real-email-1@mail.squadpitch.com>");
    expect(refs.Value).not.toContain("<should-not-be-used@form>");
  });

  it("subject stays stable across the thread (no Re: stacking)", async () => {
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async () => ({ ErrorCode: 0, MessageID: "stub" })),
    });
    const captures = [];
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        captures.push(payload.Subject);
        return { ErrorCode: 0, MessageID: "stub" };
      }),
    });
    // Send four messages without supplying a Subject override.
    for (let i = 0; i < 4; i++) {
      await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", { body: `msg ${i}` });
    }
    // All four subjects identical (no growing "Re: Re: Re:" stack).
    expect(new Set(captures).size).toBe(1);
    expect(captures[0]).toMatch(/^Re: Your inquiry/);
  });

  it("falls back safely when prior EMAIL message has no Message-ID (no headers, send still succeeds)", async () => {
    // Seed an EMAIL message that somehow lacks an externalMessageId
    // (e.g. an old row from before threading was wired).
    state.prisma.state.messages.push({
      id: "msg-legacy",
      conversationId: "conv-a",
      party: "WORKSPACE",
      channel: "EMAIL",
      body: "legacy",
      externalMessageId: null,
      createdAt: new Date("2026-05-15T10:00:00Z"),
    });

    const captured = {};
    outbound.__setPostmarkClientForTest({
      sendEmail: vi.fn(async (payload) => {
        Object.assign(captured, payload);
        return { ErrorCode: 0, MessageID: "stub" };
      }),
    });
    const sent = await outbound.sendInboxEmail("client-a", "conv-a", "auth0|u1", {
      body: "After a legacy message",
    });

    // Send completed cleanly.
    expect(sent.deliveryStatus).toBe("SENT");
    // No In-Reply-To / References — the legacy message had no ID
    // to reference. Message-ID header is still present.
    const headerNames = captured.Headers.map((h) => h.Name);
    expect(headerNames).toContain("Message-ID");
    expect(headerNames).not.toContain("In-Reply-To");
    expect(headerNames).not.toContain("References");
  });
});

// Server-side idempotency for send-email. A repeated request with
// the same (conversationId, idempotencyKey) must return the prior
// Message instead of firing a duplicate provider call.
describe("sendInboxEmail — idempotency", () => {
  beforeEach(() => {
    envOverrides = {};
    state = { prisma: baseFixture() };
    rateLimitImpl = vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterSec: 0 }));
  });

  it("returns the existing Message on a repeated key (no second Postmark call)", async () => {
    const pm = stubPostmark({ MessageID: "pm-orig" });
    outbound.__setPostmarkClientForTest(pm);

    const first = await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "Hello",
      idempotencyKey: "client-uuid-1",
    });
    const second = await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "Hello",
      idempotencyKey: "client-uuid-1",
    });

    expect(second.id).toBe(first.id);
    expect(pm.sendEmail).toHaveBeenCalledTimes(1);
    expect(state.prisma.state.messages.filter((m) => m.party === "WORKSPACE").length).toBe(1);
  });

  it("creates a NEW Message when the idempotency key differs", async () => {
    const pm = stubPostmark();
    outbound.__setPostmarkClientForTest(pm);

    await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "First",
      idempotencyKey: "uuid-a",
    });
    await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "Second",
      idempotencyKey: "uuid-b",
    });

    expect(pm.sendEmail).toHaveBeenCalledTimes(2);
    expect(state.prisma.state.messages.filter((m) => m.party === "WORKSPACE").length).toBe(2);
  });

  it("persists the idempotencyKey on the new Message row", async () => {
    outbound.__setPostmarkClientForTest(stubPostmark());
    await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "hi",
      idempotencyKey: "uuid-persist",
    });
    const row = state.prisma.state.messages.find((m) => m.party === "WORKSPACE");
    expect(row.idempotencyKey).toBe("uuid-persist");
  });

  it("returns 409 SEND_IN_PROGRESS when an existing same-key Message is still SENDING", async () => {
    // Seed a SENDING row directly (simulates the in-flight first
    // attempt — provider call hasn't finished yet).
    state.prisma.state.messages.push({
      id: "msg-inflight",
      conversationId: "conv-a",
      party: "WORKSPACE",
      channel: "EMAIL",
      body: "in flight",
      deliveryStatus: "SENDING",
      idempotencyKey: "uuid-inflight",
      createdAt: new Date(),
    });
    outbound.__setPostmarkClientForTest(stubPostmark());

    await expect(
      outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
        body: "retry",
        idempotencyKey: "uuid-inflight",
      }),
    ).rejects.toMatchObject({ status: 409, code: "SEND_IN_PROGRESS" });
  });

  it("returns the existing FAILED Message on retry with the same key (no duplicate send)", async () => {
    // Seed a FAILED row from an earlier attempt with this key.
    state.prisma.state.messages.push({
      id: "msg-failed",
      conversationId: "conv-a",
      party: "WORKSPACE",
      channel: "EMAIL",
      body: "earlier attempt",
      deliveryStatus: "FAILED",
      idempotencyKey: "uuid-failed",
      errorReason: "402: Sandbox approval required",
      createdAt: new Date(),
    });
    const pm = stubPostmark();
    outbound.__setPostmarkClientForTest(pm);

    const result = await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "retry",
      idempotencyKey: "uuid-failed",
    });

    expect(result.id).toBe("msg-failed");
    expect(result.deliveryStatus).toBe("FAILED");
    expect(pm.sendEmail).not.toHaveBeenCalled();
  });

  it("works without an idempotencyKey (legacy clients)", async () => {
    outbound.__setPostmarkClientForTest(stubPostmark());
    const result = await outbound.sendInboxEmail(CLIENT_A, "conv-a", "auth0|u1", {
      body: "no key",
    });
    expect(result.deliveryStatus).toBe("SENT");
    expect(result.idempotencyKey ?? null).toBe(null);
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
