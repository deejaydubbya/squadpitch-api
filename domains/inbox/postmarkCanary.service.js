import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";
import {
  buildReplyToAddress,
  emailOperationalStatus,
  sendSyntheticCanaryEmail,
} from "./inbox.outbound.email.service.js";

export const POSTMARK_CANARY_MARKER = "[SYNTHETIC CANARY]";

function canaryError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function required(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw canaryError(
      503,
      "POSTMARK_CANARY_NOT_CONFIGURED",
      "Postmark canary is not configured",
    );
  }
  return normalized;
}

export function loadPostmarkCanaryServerConfig(env_ = env) {
  const status = emailOperationalStatus(env_);
  if (!status.accountApproved) {
    throw canaryError(
      412,
      "EMAIL_ACCOUNT_APPROVAL_PENDING",
      "Postmark account is not approved",
    );
  }
  if (!status.senderVerified) {
    throw canaryError(
      412,
      "EMAIL_SENDER_UNVERIFIED",
      "Postmark sender is not verified",
    );
  }
  if (
    !status.providerConfigured ||
    !status.outboundStreamReady ||
    !status.inboundRoutingReady
  ) {
    throw canaryError(
      503,
      "POSTMARK_CANARY_NOT_CONFIGURED",
      "Postmark canary is not configured",
    );
  }
  return {
    token: required(env_.POSTMARK_CANARY_ACCESS_TOKEN),
    workspaceId: required(env_.POSTMARK_CANARY_ALLOWED_WORKSPACE_ID),
    conversationId: required(env_.POSTMARK_CANARY_CONVERSATION_ID),
    recipient: required(env_.POSTMARK_CANARY_ALLOWED_RECIPIENT).toLowerCase(),
  };
}

export function validCanaryToken(provided, expected) {
  if (
    typeof provided !== "string" ||
    !provided ||
    typeof expected !== "string" ||
    !expected
  ) {
    return false;
  }
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export async function runPostmarkSyntheticCanary({
  token,
  input,
  env: env_ = env,
  dependencies = {},
} = {}) {
  const config = loadPostmarkCanaryServerConfig(env_);
  if (!validCanaryToken(token, config.token)) {
    throw canaryError(
      401,
      "POSTMARK_CANARY_UNAUTHORIZED",
      "Invalid canary authorization",
    );
  }

  const workspaceId = String(input?.workspaceId ?? "").trim();
  const conversationId = String(input?.conversationId ?? "").trim();
  const recipient = String(input?.recipient ?? "").trim().toLowerCase();
  const body = String(input?.body ?? "");
  const subject = String(input?.subject ?? "");
  const correlationId = String(input?.correlationId ?? "").trim();

  if (workspaceId !== config.workspaceId) {
    throw canaryError(
      403,
      "POSTMARK_CANARY_SCOPE_MISMATCH",
      "Canary workspace is not allowlisted",
    );
  }
  if (conversationId !== config.conversationId) {
    throw canaryError(
      403,
      "POSTMARK_CANARY_SCOPE_MISMATCH",
      "Canary conversation is not allowlisted",
    );
  }
  if (!recipient || recipient !== config.recipient) {
    throw canaryError(
      403,
      "POSTMARK_CANARY_SCOPE_MISMATCH",
      "Canary recipient is not allowlisted",
    );
  }
  if (
    !body.includes(POSTMARK_CANARY_MARKER) ||
    !subject.includes(POSTMARK_CANARY_MARKER)
  ) {
    throw canaryError(
      400,
      "POSTMARK_CANARY_MARKER_REQUIRED",
      "Synthetic canary marker is required",
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      correlationId,
    )
  ) {
    throw canaryError(
      400,
      "POSTMARK_CANARY_CORRELATION_REQUIRED",
      "A valid correlation ID is required",
    );
  }

  const prisma_ = dependencies.prisma ?? prisma;
  const send = dependencies.send ?? sendSyntheticCanaryEmail;
  const conversation = await prisma_.conversation.findFirst({
    where: { id: conversationId, clientId: workspaceId },
    include: { contact: true },
  });
  if (!conversation) {
    throw canaryError(
      404,
      "POSTMARK_CANARY_CONVERSATION_NOT_FOUND",
      "Synthetic conversation was not found",
    );
  }
  if (
    String(conversation.contact?.email ?? "")
      .trim()
      .toLowerCase() !== config.recipient
  ) {
    throw canaryError(
      403,
      "POSTMARK_CANARY_SCOPE_MISMATCH",
      "Canary recipient is not allowlisted",
    );
  }
  const syntheticLabel = `${conversation.subject ?? ""} ${
    conversation.contact?.name ?? ""
  }`;
  if (!syntheticLabel.includes(POSTMARK_CANARY_MARKER)) {
    throw canaryError(
      403,
      "POSTMARK_CANARY_CONVERSATION_REQUIRED",
      "Conversation is not synthetic",
    );
  }

  const replyTo = buildReplyToAddress(env_, conversationId);
  if (!replyTo || !replyTo.includes(`reply+${conversationId}@`)) {
    throw canaryError(
      503,
      "POSTMARK_CANARY_NOT_CONFIGURED",
      "Postmark reply threading is not configured",
    );
  }

  const message = await send(workspaceId, conversationId, {
    body,
    subject,
    idempotencyKey: correlationId,
  });
  return {
    status: message.deliveryStatus,
    messageId: message.id,
    providerMessageIdPersisted: Boolean(message.providerMessageId),
    senderConfigured: Boolean(env_.INBOX_EMAIL_FROM),
    replyToThreadingConfigured: true,
  };
}
