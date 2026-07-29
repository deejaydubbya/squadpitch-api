// SquadInbox outbound — workspace user → SMS (Twilio).
//
// Mirrors the email / GBP / YouTube / Threads outbound services:
// write a Message in SENDING state BEFORE the Twilio call, flip
// to SENT or FAILED so the audit trail survives every outcome.
// Idempotency key dedupes double-clicks + network retries.
//
// Capability contract (any failure → 412 PROVIDER_NOT_AVAILABLE):
//   - env.SMS_SENDING_ENABLED must be true (operational kill
//     switch — lets us roll the code without flipping live send).
//   - env.SMS_A2P_APPROVED must be true (Twilio Brand + Campaign
//     both APPROVED; US carriers throttle/block unregistered
//     campaigns and reject sends from non-business profiles).
//   - env.TWILIO_ACCOUNT_SID / _AUTH_TOKEN / _FROM_NUMBER set.
//   - Conversation belongs to clientId.
//   - Contact has a phone number.
//   - Contact has not opted out (enrichmentJson.smsOptOut !== true).
//
// Compliance:
//   - First outbound SMS to a contact gets the standard "Reply
//     STOP to opt out." footer appended. We track the
//     first-send marker on Contact.enrichmentJson.smsFooterSentAt
//     so subsequent messages stay clean. The footer is included
//     in segment counting before we send (160 GSM-7 chars / 70
//     UCS-2 chars per segment).
//   - Twilio's Advanced Opt-Out handles STOP/HELP at the carrier
//     level if 10DLC is registered. When inbound SMS lands, the
//     webhook will flip smsOptOut=true on the contact and any
//     future send short-circuits with PROVIDER_NOT_AVAILABLE.

import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { sendSms } from "../notifications/providers/twilioSmsProvider.js";
import { checkRateLimit } from "../sites/rateLimit.js";

const STOP_FOOTER = "\n\nReply STOP to opt out.";

class SmsReplyError extends Error {
  constructor(message, { status, code, providerError } = {}) {
    super(message);
    this.name = "SmsReplyError";
    this.status = status ?? 502;
    this.code = code ?? "SMS_SEND_FAILED";
    this.providerError = providerError ?? null;
  }
}

function isSmsConfigured() {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_FROM_NUMBER &&
    env.TWILIO_MESSAGING_SERVICE_SID,
  );
}

/**
 * Send an SMS reply on an inbox conversation.
 *
 * Throws (status + code):
 *   400 BODY_REQUIRED
 *   404 CONVERSATION_NOT_FOUND
 *   404 CONTACT_NO_PHONE
 *   412 PROVIDER_NOT_AVAILABLE   (A2P gate, missing config, opt-out)
 *   409 SEND_IN_PROGRESS
 *   502 PROVIDER_FAILED
 *   503 PROVIDER_UNREACHABLE
 */
export async function sendInboxSms(
  clientId,
  conversationId,
  userId,
  { body, idempotencyKey } = {},
) {
  // Pre-flight gates — the resolver should have prevented this
  // call when any of these fail, but we re-check server-side so
  // a stale UI cache can't slip a send past us.
  if (!env.SMS_SENDING_ENABLED) {
    throw new SmsReplyError("SMS sending is not enabled in this workspace.", {
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
    });
  }
  if (!env.SMS_A2P_APPROVED) {
    throw new SmsReplyError(
      "Awaiting Twilio business profile / A2P 10DLC approval.",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }
  if (!isSmsConfigured()) {
    throw new SmsReplyError(
      "SMS sending is not configured for this workspace yet.",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    throw new SmsReplyError("Body is required", {
      status: 400,
      code: "BODY_REQUIRED",
    });
  }
  const trimmed = body.trim();

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    select: {
      id: true,
      contactId: true,
      spam: true,
      contact: {
        select: {
          id: true,
          phone: true,
          enrichmentJson: true,
        },
      },
    },
  });
  if (!conversation) {
    throw new SmsReplyError("Conversation not found", {
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
  }
  if (conversation.spam) {
    throw new SmsReplyError(
      "Conversation is marked as spam — unmark before sending.",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }
  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SmsReplyError("This lead has no phone number on file.", {
      status: 404,
      code: "CONTACT_NO_PHONE",
    });
  }
  if (contact.enrichmentJson?.smsOptOut === true) {
    throw new SmsReplyError("Contact has opted out of SMS (replied STOP).", {
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
    });
  }

  // Decide whether to append the compliance footer. First send
  // to this contact gets it; subsequent sends stay clean. We
  // check Contact.enrichmentJson.smsFooterSentAt as the marker
  // rather than counting prior messages — cheaper + survives
  // message deletion.
  const isFirstSend = !contact.enrichmentJson?.smsFooterSentAt;
  const finalBody = isFirstSend ? trimmed + STOP_FOOTER : trimmed;
  if (finalBody.length > (env.INBOX_SMS_MAX_CHARS ?? 480)) {
    throw new SmsReplyError("SMS exceeds the configured message length cap.", {
      status: 400,
      code: "MESSAGE_TOO_LONG",
    });
  }

  // Idempotency pre-check.
  if (idempotencyKey) {
    const existing = await prisma.message.findFirst({
      where: { conversationId, idempotencyKey },
    });
    if (existing) {
      if (existing.deliveryStatus === "SENDING") {
        throw new SmsReplyError(
          "An SMS with this idempotency key is already in progress",
          { status: 409, code: "SEND_IN_PROGRESS" },
        );
      }
      return existing;
    }
  }

  const cap = env.INBOX_SMS_DAILY_CAP ?? 50;
  const rate = await checkRateLimit("inbox-sms", clientId, cap, 24 * 60 * 60);
  if (!rate.allowed) {
    throw new SmsReplyError(`Workspace daily SMS cap (${cap}) reached.`, {
      status: 429,
      code: "RATE_LIMITED",
    });
  }

  // Step 1: write Message in SENDING state BEFORE the provider
  // call. An in-flight crash leaves an auditable row.
  let messageRow;
  try {
    messageRow = await prisma.message.create({
      data: {
        conversationId,
        party: "WORKSPACE",
        channel: "SMS",
        body: finalBody,
        authorUserId: userId,
        idempotencyKey: idempotencyKey ?? null,
        visibility: "PUBLIC", // SMS isn't really public, but it's user-visible
        deliveryStatus: "SENDING",
        lastAttemptedAt: new Date(),
      },
    });
  } catch (createErr) {
    if (idempotencyKey && createErr?.code === "P2002") {
      const racedWinner = await prisma.message.findFirst({
        where: { conversationId, idempotencyKey },
      });
      if (racedWinner) {
        if (racedWinner.deliveryStatus === "SENDING") {
          throw new SmsReplyError(
            "An SMS with this idempotency key is already in progress",
            { status: 409, code: "SEND_IN_PROGRESS" },
          );
        }
        return racedWinner;
      }
    }
    throw createErr;
  }

  // Step 2: call Twilio.
  let providerMessageId = null;
  try {
    const result = await sendSms({ to: contact.phone, body: finalBody });
    providerMessageId = result?.sid ?? null;
    // sendSms returns null when Twilio isn't configured — but we
    // already checked above, so a null here means the provider
    // module no-op'd unexpectedly. Treat as a provider failure.
    if (!providerMessageId) {
      throw new SmsReplyError("Twilio did not return a message sid", {
        status: 502,
        code: "PROVIDER_FAILED",
      });
    }
  } catch (callErr) {
    const reason = callErr?.message ?? "Twilio send failed";
    const httpStatus = callErr?.status ?? 502;
    console.error("[INBOX_OUTBOUND_SMS] Twilio send threw:", {
      messageId: messageRow.id,
      conversationId,
      clientId,
      status: httpStatus,
      message: reason,
    });
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: `${httpStatus}: ${reason}`.slice(0, 4000),
      },
    });
    if (callErr instanceof SmsReplyError) throw callErr;
    throw new SmsReplyError(reason, {
      status: httpStatus >= 400 && httpStatus < 500 ? 502 : 503,
      code:
        httpStatus >= 400 && httpStatus < 500
          ? "PROVIDER_FAILED"
          : "PROVIDER_UNREACHABLE",
      providerError: reason,
    });
  }

  // Step 3: mark SENT.
  const sent = await prisma.message.update({
    where: { id: messageRow.id },
    data: {
      deliveryStatus: "SENT",
      providerMessageId,
      externalMessageId: providerMessageId,
    },
  });

  // Step 4: bump conversation + stamp the contact's footer-sent
  // marker so subsequent sends skip the compliance suffix.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: sent.createdAt,
      lastMessageFrom: "WORKSPACE",
      workspaceReadAt: sent.createdAt,
    },
  });
  if (isFirstSend) {
    await prisma.contact
      .update({
        where: { id: contact.id },
        data: {
          enrichmentJson: {
            ...(contact.enrichmentJson ?? {}),
            smsFooterSentAt: new Date().toISOString(),
          },
        },
      })
      .catch(() => {});
  }

  console.log("[INBOX_OUTBOUND_SMS] sent →", {
    clientId,
    conversationId,
    messageId: sent.id,
    providerMessageId,
    appendedFooter: isFirstSend,
  });

  return sent;
}
