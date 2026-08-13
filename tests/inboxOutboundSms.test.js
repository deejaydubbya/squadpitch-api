// SquadInbox outbound — SMS via Twilio.
//
// Pins the gates, idempotency, opt-out short-circuit, STOP-footer
// on first send only, and the SENDING → SENT/FAILED state machine.
// No real Twilio API calls — the provider module is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

let envOverrides;
vi.mock("../config/env.js", () => ({
  get env() {
    return envOverrides;
  },
}));

const twilioMock = {
  sendSms: vi.fn(),
};
vi.mock(
  "../domains/notifications/providers/twilioSmsProvider.js",
  () => twilioMock,
);
vi.mock("../domains/sites/rateLimit.js", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { sendInboxSms } =
  await import("../domains/inbox/inbox.outbound.sms.service.js");
const { checkRateLimit } = await import("../domains/sites/rateLimit.js");

const CLIENT_ID = "client-sms-1";
const CONV_ID = "conv-sms-1";
const CONTACT_ID = "contact-sms-1";
const PHONE = "+15551234567";
const USER_ID = "auth0|user";

function createPrismaMock({ contact = {}, conversation = {} } = {}) {
  const messages = [];
  let messageCounter = 0;
  const contactRow = {
    id: CONTACT_ID,
    phone: PHONE,
    enrichmentJson: null,
    ...contact,
  };
  const conversationRow = {
    id: CONV_ID,
    contactId: CONTACT_ID,
    spam: false,
    contact: contactRow,
    ...conversation,
  };
  return {
    state: { messages, contact: contactRow, conversation: conversationRow },
    client: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === CLIENT_ID ? { id: CLIENT_ID, lifecycle: "CUSTOMER" } : null,
      ),
    },
    conversation: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.id === CONV_ID && where.clientId === CLIENT_ID)
          return conversationRow;
        return null;
      }),
      update: vi.fn(async () => ({})),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        return (
          messages.find((m) => m.idempotencyKey === where.idempotencyKey) ??
          null
        );
      }),
      create: vi.fn(async ({ data }) => {
        const id = `msg-${++messageCounter}`;
        const row = { id, createdAt: new Date(), ...data };
        messages.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const m = messages.find((x) => x.id === where.id);
        if (m) Object.assign(m, data);
        return m;
      }),
    },
    contact: {
      update: vi.fn(async ({ where, data }) => {
        if (where.id === contactRow.id) Object.assign(contactRow, data);
        return contactRow;
      }),
    },
  };
}

beforeEach(() => {
  envOverrides = {
    SMS_SENDING_ENABLED: true,
    SMS_A2P_APPROVED: true,
    TWILIO_ACCOUNT_SID: "AC...",
    TWILIO_AUTH_TOKEN: "secret",
    TWILIO_FROM_NUMBER: "+15550000000",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"b".repeat(32)}`,
    INBOX_SMS_DAILY_CAP: 50,
    INBOX_SMS_MAX_CHARS: 480,
  };
  twilioMock.sendSms.mockReset();
  twilioMock.sendSms.mockResolvedValue({ sid: "SM_abc123" });
  prismaMock = createPrismaMock();
});

describe("sendInboxSms — suspended provider", () => {
  it("rejects a PROSPECT lifecycle before the suspended-provider gate", async () => {
    prismaMock.client.findUnique.mockResolvedValue({ id: CLIENT_ID, lifecycle: "PROSPECT" });
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({ code: "PROSPECT_SIDE_EFFECT_BLOCKED", status: 409 });
    expect(prismaMock.conversation.findFirst).not.toHaveBeenCalled();
    expect(twilioMock.sendSms).not.toHaveBeenCalled();
  });

  it("always returns SMS_UNAVAILABLE before conversation, billing, queue, or provider work", async () => {
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({
      code: "SMS_UNAVAILABLE",
      status: 503,
      message: "SMS is temporarily unavailable.",
    });
    expect(prismaMock.conversation.findFirst).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(twilioMock.sendSms).not.toHaveBeenCalled();
  });
});

describe.skip("sendInboxSms — preserved reactivation gates", () => {
  it("refuses when SMS_SENDING_ENABLED is false", async () => {
    envOverrides.SMS_SENDING_ENABLED = false;
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
      message: /sms sending is not enabled/i,
    });
    expect(twilioMock.sendSms).not.toHaveBeenCalled();
  });

  it("refuses when SMS_A2P_APPROVED is false", async () => {
    envOverrides.SMS_A2P_APPROVED = false;
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
      message: /Awaiting Twilio business profile \/ A2P 10DLC approval/i,
    });
    expect(twilioMock.sendSms).not.toHaveBeenCalled();
  });

  it("refuses when Twilio env vars are missing", async () => {
    envOverrides.TWILIO_ACCOUNT_SID = null;
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
      message: /not configured/i,
    });
  });

  it("refuses when contact has no phone", async () => {
    prismaMock = createPrismaMock({ contact: { phone: null } });
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({ code: "CONTACT_NO_PHONE" });
  });

  it("refuses when contact has opted out (STOP)", async () => {
    prismaMock = createPrismaMock({
      contact: { enrichmentJson: { smsOptOut: true } },
    });
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
      message: /opted out/i,
    });
    expect(twilioMock.sendSms).not.toHaveBeenCalled();
  });
});

describe.skip("sendInboxSms — preserved happy path + footer", () => {
  it("appends 'Reply STOP to opt out.' on the first send to a contact", async () => {
    await sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, {
      body: "Thanks for the message!",
    });
    expect(twilioMock.sendSms).toHaveBeenCalledTimes(1);
    const call = twilioMock.sendSms.mock.calls[0][0];
    expect(call.to).toBe(PHONE);
    expect(call.body).toContain("Thanks for the message!");
    expect(call.body).toContain("Reply STOP to opt out.");
    // Contact gets a marker so the next send skips the footer.
    expect(
      prismaMock.state.contact.enrichmentJson?.smsFooterSentAt,
    ).toBeTruthy();
  });

  it("does NOT append the footer when the contact has already received one", async () => {
    prismaMock = createPrismaMock({
      contact: {
        enrichmentJson: { smsFooterSentAt: "2026-05-16T10:00:00Z" },
      },
    });
    await sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "Following up." });
    const call = twilioMock.sendSms.mock.calls[0][0];
    expect(call.body).toBe("Following up.");
    expect(call.body).not.toContain("STOP");
  });

  it("writes Message in SENDING then flips to SENT with the Twilio sid", async () => {
    await sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" });
    const msg = prismaMock.state.messages[0];
    expect(msg.party).toBe("WORKSPACE");
    expect(msg.channel).toBe("SMS");
    expect(msg.deliveryStatus).toBe("SENT");
    expect(msg.providerMessageId).toBe("SM_abc123");
    expect(msg.externalMessageId).toBe("SM_abc123");
  });

  it("blocks oversized messages before contacting Twilio", async () => {
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, {
        body: "x".repeat(481),
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_TOO_LONG", status: 400 });
    expect(twilioMock.sendSms).not.toHaveBeenCalled();
  });

  it("enforces the per-workspace daily cap", async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false });
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(twilioMock.sendSms).not.toHaveBeenCalled();
  });
});

describe.skip("sendInboxSms — preserved idempotency + failure", () => {
  it("returns the existing message on a repeated idempotency-key send (no extra Twilio call)", async () => {
    const opts = { body: "hi", idempotencyKey: "key-1" };
    const first = await sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, opts);
    const second = await sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, opts);
    expect(second.id).toBe(first.id);
    expect(twilioMock.sendSms).toHaveBeenCalledTimes(1);
  });

  it("marks the message FAILED with the Twilio error reason when send throws", async () => {
    twilioMock.sendSms.mockRejectedValueOnce(
      Object.assign(new Error("Twilio rejected: invalid number"), {
        status: 400,
      }),
    );
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
    const msg = prismaMock.state.messages[0];
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.errorReason).toMatch(/Twilio rejected/);
  });

  it("marks timeouts FAILED and reports the provider as unreachable", async () => {
    twilioMock.sendSms.mockRejectedValueOnce(
      Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
    );
    await expect(
      sendInboxSms(CLIENT_ID, CONV_ID, USER_ID, { body: "hi" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE", status: 503 });
    expect(prismaMock.state.messages[0].deliveryStatus).toBe("FAILED");
  });
});
