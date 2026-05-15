// Postmark inbound webhook — parser tests.
//
// We test the inbound *service* directly with a mocked prisma so
// every persistence path is exercised without needing express +
// supertest. The webhook *route* (secret verification) is covered
// by a second describe block that boots the express app via the
// router directly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";

let state;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return state.prisma;
  },
}));

// Env stub — the route reads POSTMARK_INBOUND_WEBHOOK_SECRET from
// the env helper, so we control it here per test.
let envOverrides = {};
vi.mock("../config/env.js", () => ({
  get env() {
    return {
      POSTMARK_INBOUND_WEBHOOK_SECRET: "test-secret",
      ...envOverrides,
    };
  },
}));

const service = await import("../domains/inbox/inbox.inbound.email.service.js");
const { inboxWebhookRouter } = await import(
  "../domains/inbox/inbox.webhook.routes.js"
);

// ── Prisma mock builder ────────────────────────────────────────────────

function buildPrismaMock({ conversations = [], messages = [] } = {}) {
  const convs = new Map(conversations.map((c) => [c.id, c]));
  const msgs = [...messages];
  let msgCounter = 0;
  return {
    state: { convs, msgs },
    conversation: {
      findUnique: vi.fn(async ({ where }) => convs.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }) => {
        const c = convs.get(where.id);
        const next = { ...c, ...data };
        convs.set(where.id, next);
        return next;
      }),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        for (const m of msgs) {
          if (m.conversationId !== where.conversationId) continue;
          if (where.channel && m.channel !== where.channel) continue;
          if (where.OR) {
            const matched = where.OR.some((cond) => {
              if (cond.providerMessageId && m.providerMessageId === cond.providerMessageId)
                return true;
              if (cond.externalMessageId && m.externalMessageId === cond.externalMessageId)
                return true;
              return false;
            });
            if (!matched) continue;
          }
          return m;
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `msg-in-${++msgCounter}`,
          createdAt: data.createdAt ?? new Date(),
          ...data,
        };
        msgs.push(row);
        return row;
      }),
    },
    contact: {
      // Should NEVER be called from the inbound path — assertions
      // below rely on this.
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  };
}

function basePayload(overrides = {}) {
  return {
    From: "lead@external.com",
    FromName: "Lead Person",
    Subject: "Re: Your inquiry to Smith Realty",
    TextBody: "Yes, please send me more details about 508 King George Court.",
    HtmlBody: "<p>Yes, please send me more details.</p>",
    Date: "Wed, 15 May 2026 20:00:00 +0000",
    MessageID: "<external-postmark-id-123@postmarkapp.com>",
    MailboxHash: "conv-abc",
    To: "reply+conv-abc@mail.squadpitch.com",
    ToFull: [
      { Email: "reply+conv-abc@mail.squadpitch.com", Name: "" },
    ],
    OriginalRecipient: "reply+conv-abc@mail.squadpitch.com",
    Attachments: [],
    ...overrides,
  };
}

// ── Service-layer tests ────────────────────────────────────────────────

describe("inbound — happy path", () => {
  beforeEach(() => {
    envOverrides = {};
    state = {
      prisma: buildPrismaMock({
        conversations: [
          {
            id: "conv-abc",
            clientId: "client-1",
            status: "OPEN",
            spam: false,
            workspaceReadAt: new Date("2026-05-15T10:00:00Z"),
          },
        ],
      }),
    };
  });

  it("creates a CONTACT EMAIL message in the existing conversation", async () => {
    const result = await service.processInboundEmail(basePayload());
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("CREATED");
    const msg = state.prisma.state.msgs[0];
    expect(msg.conversationId).toBe("conv-abc");
    expect(msg.party).toBe("CONTACT");
    expect(msg.channel).toBe("EMAIL");
    expect(msg.body).toContain("508 King George Court");
    expect(msg.providerMessageId).toBe("<external-postmark-id-123@postmarkapp.com>");
    expect(msg.deliveryStatus).toBe("SENT");
  });

  it("stores only safe metadata in payloadJson (no HTML, no attachment content)", async () => {
    await service.processInboundEmail(
      basePayload({
        Attachments: [
          { Name: "spec.pdf", ContentType: "application/pdf", ContentLength: 1024, Content: "BASE64-NEVER-STORED" },
        ],
      }),
    );
    const msg = state.prisma.state.msgs[0];
    expect(msg.payloadJson).toMatchObject({
      from: "lead@external.com",
      fromName: "Lead Person",
      subject: "Re: Your inquiry to Smith Realty",
      messageId: "<external-postmark-id-123@postmarkapp.com>",
    });
    // Attachment metadata only — no Content field.
    expect(msg.payloadJson.attachments).toEqual([
      { name: "spec.pdf", contentType: "application/pdf", contentLength: 1024 },
    ]);
    // Defense in depth — make sure the raw base64 NEVER landed
    // anywhere in the persisted row.
    const serialized = JSON.stringify(msg);
    expect(serialized).not.toContain("BASE64-NEVER-STORED");
  });

  it("updates conversation lastMessageAt / lastMessageFrom and leaves it unread", async () => {
    const before = new Date(state.prisma.state.convs.get("conv-abc").workspaceReadAt);
    await service.processInboundEmail(basePayload());
    const conv = state.prisma.state.convs.get("conv-abc");
    expect(conv.lastMessageFrom).toBe("CONTACT");
    expect(conv.lastMessageAt.getTime()).toBeGreaterThan(before.getTime());
    // workspaceReadAt deliberately NOT touched — the existing
    // decorateUnread rule will mark this conv as unread.
    expect(conv.workspaceReadAt.getTime()).toBe(before.getTime());
  });

  it("reopens a CLOSED conversation when a new reply arrives", async () => {
    state.prisma.state.convs.get("conv-abc").status = "CLOSED";
    await service.processInboundEmail(basePayload());
    expect(state.prisma.state.convs.get("conv-abc").status).toBe("OPEN");
  });

  it("never creates a Contact on inbound", async () => {
    await service.processInboundEmail(basePayload());
    expect(state.prisma.contact.create).not.toHaveBeenCalled();
    expect(state.prisma.contact.update).not.toHaveBeenCalled();
  });
});

describe("inbound — duplicate (Postmark retry)", () => {
  beforeEach(() => {
    envOverrides = {};
    state = {
      prisma: buildPrismaMock({
        conversations: [
          { id: "conv-abc", clientId: "client-1", status: "OPEN", spam: false },
        ],
        messages: [
          {
            id: "existing-msg",
            conversationId: "conv-abc",
            channel: "EMAIL",
            party: "CONTACT",
            providerMessageId: "<external-postmark-id-123@postmarkapp.com>",
          },
        ],
      }),
    };
  });

  it("does NOT create a second message for the same Postmark MessageID", async () => {
    const result = await service.processInboundEmail(basePayload());
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ALREADY_PROCESSED");
    // Still exactly one message — no duplicate persisted.
    expect(state.prisma.state.msgs).toHaveLength(1);
  });
});

describe("inbound — conversation id extraction", () => {
  beforeEach(() => {
    envOverrides = {};
    state = {
      prisma: buildPrismaMock({
        conversations: [
          // Real cuid format (Prisma @default(cuid)) — pure [a-z0-9].
          { id: "cmp79j0v3000csohpabzj4md9", clientId: "client-1", status: "OPEN", spam: false },
        ],
      }),
    };
  });

  it("prefers MailboxHash when present", () => {
    expect(
      service.extractConversationId({
        MailboxHash: "convhash123",
        To: "reply+cmp79j0v3000csohpabzj4md9@mail.squadpitch.com",
      }),
    ).toBe("convhash123");
  });

  it("falls back to To when MailboxHash is missing", () => {
    expect(
      service.extractConversationId({
        To: "reply+cmp79j0v3000csohpabzj4md9@mail.squadpitch.com",
      }),
    ).toBe("cmp79j0v3000csohpabzj4md9");
  });

  it("handles ToFull array", () => {
    expect(
      service.extractConversationId({
        ToFull: [{ Email: "reply+abc123@mail.squadpitch.com" }],
      }),
    ).toBe("abc123");
  });

  it("returns null when no candidate matches the reply+ pattern", () => {
    expect(
      service.extractConversationId({
        To: "support@mail.squadpitch.com",
      }),
    ).toBeNull();
  });

  it("rejects payload entirely when no conv id can be extracted", async () => {
    const result = await service.processInboundEmail({
      From: "lead@external.com",
      TextBody: "hi",
      To: "support@mail.squadpitch.com",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_CONVERSATION_HASH");
    expect(state.prisma.state.msgs).toHaveLength(0);
  });

  it("returns CONVERSATION_NOT_FOUND (ok=false but no leak) for unknown conv id", async () => {
    const result = await service.processInboundEmail(
      basePayload({ MailboxHash: "nonexistent-conv" }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONVERSATION_NOT_FOUND");
    expect(state.prisma.state.msgs).toHaveLength(0);
  });
});

describe("inbound — body parsing", () => {
  beforeEach(() => {
    envOverrides = {};
    state = {
      prisma: buildPrismaMock({
        conversations: [
          { id: "conv-abc", clientId: "client-1", status: "OPEN", spam: false },
        ],
      }),
    };
  });

  it("converts HtmlBody to text safely when TextBody is missing", async () => {
    await service.processInboundEmail(
      basePayload({
        TextBody: null,
        HtmlBody:
          "<html><head><style>body{color:red}</style></head><body><script>alert(1)</script><p>Hello there</p><p>Second paragraph</p></body></html>",
      }),
    );
    const msg = state.prisma.state.msgs[0];
    expect(msg.body).toContain("Hello there");
    expect(msg.body).toContain("Second paragraph");
    // Script + style content should NEVER survive into the body.
    expect(msg.body).not.toMatch(/alert/);
    expect(msg.body).not.toMatch(/color:red/);
    // No raw HTML tags.
    expect(msg.body).not.toMatch(/<[a-z]/);
  });

  it("strips quoted thread (On … wrote:) from TextBody", () => {
    const out = service.stripQuotedReply(
      "Yes, that works for me.\n\nOn Wed, May 15, 2026 at 3:00 PM Smith Realty <inbox@mail.squadpitch.com> wrote:\n> Would Saturday work?",
    );
    expect(out).toBe("Yes, that works for me.");
  });

  it('renders "[Email reply received with attachments]" when body is empty', async () => {
    await service.processInboundEmail(
      basePayload({
        TextBody: "",
        HtmlBody: "",
        Attachments: [
          { Name: "f.pdf", ContentType: "application/pdf", ContentLength: 1 },
        ],
      }),
    );
    expect(state.prisma.state.msgs[0].body).toBe(
      "[Email reply received with attachments]",
    );
  });
});

describe("inbound — cross-tenant safety", () => {
  beforeEach(() => {
    envOverrides = {};
    state = {
      prisma: buildPrismaMock({
        conversations: [
          { id: "conv-a", clientId: "client-A", status: "OPEN", spam: false },
          { id: "conv-b", clientId: "client-B", status: "OPEN", spam: false },
        ],
      }),
    };
  });

  it("attaches strictly to the conversation id extracted from the routed address (ignores any payload-claimed workspace)", async () => {
    // Even if a hostile webhook payload tried to claim workspace
    // information via fields like "Headers" or "MessageStream",
    // we ignore everything except the conv id from the
    // MailboxHash / To address. This test pins that the payload
    // can't redirect persistence to another conversation.
    await service.processInboundEmail({
      ...basePayload({
        MailboxHash: "conv-a",
        To: "reply+conv-a@mail.squadpitch.com",
      }),
      // Hostile decoy fields — should have no effect.
      conversationId: "conv-b",
      clientId: "client-B",
      MessageStream: "outbound",
    });
    const msg = state.prisma.state.msgs[0];
    expect(msg.conversationId).toBe("conv-a");
  });
});

// ── Route-layer tests (secret verification) ────────────────────────────

function startTestServer() {
  const app = express();
  app.use(inboxWebhookRouter);
  // global error handler so the test sees the status instead of
  // an uncaught exception.
  app.use((err, _req, res, _next) => {
    res.status(500).json({ ok: false, error: err.message });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/api/v1/webhooks/postmark/inbound`,
      });
    });
  });
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("webhook — secret verification", () => {
  beforeEach(() => {
    envOverrides = {};
    state = {
      prisma: buildPrismaMock({
        conversations: [
          { id: "conv-abc", clientId: "client-1", status: "OPEN", spam: false },
        ],
      }),
    };
  });

  it("rejects with 403 when no secret is provided", async () => {
    const { server, url } = await startTestServer();
    try {
      const res = await postJson(url, basePayload());
      expect(res.status).toBe(403);
      // Body should not echo the configured secret.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("test-secret");
    } finally {
      server.close();
    }
  });

  it("rejects with 403 when the secret value is wrong", async () => {
    const { server, url } = await startTestServer();
    try {
      const res = await postJson(url, basePayload(), {
        "x-postmark-secret": "wrong-value",
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it("accepts X-Postmark-Secret header", async () => {
    const { server, url } = await startTestServer();
    try {
      const res = await postJson(url, basePayload(), {
        "x-postmark-secret": "test-secret",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.reason).toBe("CREATED");
    } finally {
      server.close();
    }
  });

  it("accepts query-param secret", async () => {
    const { server, url } = await startTestServer();
    try {
      const res = await postJson(
        `${url}?secret=test-secret`,
        basePayload(),
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("accepts HTTP Basic Auth", async () => {
    const { server, url } = await startTestServer();
    try {
      const basic = Buffer.from("postmark:test-secret").toString("base64");
      const res = await postJson(url, basePayload(), {
        authorization: `Basic ${basic}`,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns 200 with reason=CONVERSATION_NOT_FOUND for unknown conv id (no retry storm)", async () => {
    const { server, url } = await startTestServer();
    try {
      const res = await postJson(
        url,
        basePayload({ MailboxHash: "ghost-conv" }),
        { "x-postmark-secret": "test-secret" },
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe("CONVERSATION_NOT_FOUND");
    } finally {
      server.close();
    }
  });
});
