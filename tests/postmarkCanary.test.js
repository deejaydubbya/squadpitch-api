import { describe, expect, it, vi } from "vitest";
import {
  loadPostmarkCanaryServerConfig,
  runPostmarkSyntheticCanary,
  validCanaryToken,
} from "../domains/inbox/postmarkCanary.service.js";
import { emailCapabilityDetailsFor } from "../domains/inbox/inbox.outbound.email.service.js";

const MARKER = "[SYNTHETIC CANARY]";
const correlationId = "123e4567-e89b-42d3-a456-426614174000";
const baseEnv = {
  POSTMARK_SERVER_TOKEN: "configured",
  INBOX_EMAIL_FROM: "Squadpitch <inbox@example.test>",
  INBOX_EMAIL_REPLY_DOMAIN: "reply.example.test",
  POSTMARK_INBOUND_WEBHOOK_SECRET: "configured",
  POSTMARK_MESSAGE_STREAM: "outbound",
  POSTMARK_ACCOUNT_APPROVED: true,
  POSTMARK_SENDER_VERIFIED: true,
  POSTMARK_DELIVERY_VERIFIED: false,
  POSTMARK_CANARY_ACCESS_TOKEN: "dedicated-secret",
  POSTMARK_CANARY_ALLOWED_WORKSPACE_ID: "synthetic-workspace",
  POSTMARK_CANARY_CONVERSATION_ID: "synthetic-conversation",
  POSTMARK_CANARY_ALLOWED_RECIPIENT: "operator@example.test",
};
const conversation = {
  id: "synthetic-conversation",
  clientId: "synthetic-workspace",
  subject: `${MARKER} Postmark`,
  contact: { name: "Operator", email: "operator@example.test" },
};
const input = {
  workspaceId: "synthetic-workspace",
  conversationId: "synthetic-conversation",
  recipient: "operator@example.test",
  subject: `${MARKER} Postmark verification`,
  body: `${MARKER} controlled verification`,
  correlationId,
};

function dependencies(conversationValue = conversation) {
  return {
    prisma: {
      conversation: { findFirst: vi.fn().mockResolvedValue(conversationValue) },
    },
    send: vi.fn().mockResolvedValue({
      id: "message-id",
      deliveryStatus: "SENT",
      providerMessageId: "provider-id",
    }),
  };
}

async function run(overrides = {}) {
  return runPostmarkSyntheticCanary({
    token: "dedicated-secret",
    input,
    env: baseEnv,
    dependencies: dependencies(),
    ...overrides,
  });
}

describe("Postmark synthetic canary authorization", () => {
  it("uses constant-time token validation semantics", () => {
    expect(validCanaryToken("dedicated-secret", "dedicated-secret")).toBe(true);
    expect(validCanaryToken("wrong", "dedicated-secret")).toBe(false);
    expect(validCanaryToken("", "dedicated-secret")).toBe(false);
  });

  it("succeeds with every requirement while normal capability stays disabled", async () => {
    const result = await run();
    expect(result).toMatchObject({
      status: "SENT",
      providerMessageIdPersisted: true,
      senderConfigured: true,
      replyToThreadingConfigured: true,
    });
    expect(
      emailCapabilityDetailsFor({
        conversation,
        contact: conversation.contact,
        env: baseEnv,
      }),
    ).toMatchObject({
      canSend: false,
      blockedCode: "EMAIL_DELIVERY_UNVERIFIED",
    });
  });

  it.each([
    ["wrong workspace", { workspaceId: "customer-workspace" }, "SCOPE_MISMATCH"],
    ["wrong conversation", { conversationId: "customer-conversation" }, "SCOPE_MISMATCH"],
    ["wrong recipient", { recipient: "customer@example.test" }, "SCOPE_MISMATCH"],
    ["missing body marker", { body: "ordinary message" }, "MARKER_REQUIRED"],
    ["missing subject marker", { subject: "ordinary subject" }, "MARKER_REQUIRED"],
  ])("rejects %s", async (_label, inputOverride, code) => {
    await expect(run({ input: { ...input, ...inputOverride } })).rejects.toMatchObject({
      code: expect.stringContaining(code),
    });
  });

  it("rejects an invalid dedicated token", async () => {
    await expect(run({ token: "wrong" })).rejects.toMatchObject({
      code: "POSTMARK_CANARY_UNAUTHORIZED",
    });
  });

  it("rejects a non-synthetic conversation", async () => {
    const ordinary = { ...conversation, subject: "Ordinary conversation" };
    await expect(
      run({ dependencies: dependencies(ordinary) }),
    ).rejects.toMatchObject({ code: "POSTMARK_CANARY_CONVERSATION_REQUIRED" });
  });

  it("rejects a substituted database recipient", async () => {
    const substituted = {
      ...conversation,
      contact: { ...conversation.contact, email: "customer@example.test" },
    };
    await expect(
      run({ dependencies: dependencies(substituted) }),
    ).rejects.toMatchObject({ code: "POSTMARK_CANARY_SCOPE_MISMATCH" });
  });

  it("fails closed when canary config is missing", () => {
    expect(() =>
      loadPostmarkCanaryServerConfig({
        ...baseEnv,
        POSTMARK_CANARY_ACCESS_TOKEN: "",
      }),
    ).toThrow(/not configured/i);
  });

  it("fails closed when account or sender verification is false", () => {
    expect(() =>
      loadPostmarkCanaryServerConfig({
        ...baseEnv,
        POSTMARK_ACCOUNT_APPROVED: false,
      }),
    ).toThrow(/not approved/i);
    expect(() =>
      loadPostmarkCanaryServerConfig({
        ...baseEnv,
        POSTMARK_SENDER_VERIFIED: false,
      }),
    ).toThrow(/not verified/i);
  });
});
