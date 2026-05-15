// SquadInbox outbound email — user → lead replies via Postmark.
//
// Deliberately separate from notifications/providers/postmarkEmailProvider.js
// (the system-notification path):
//   - Different From: header (INBOX_EMAIL_FROM, not NOTIFICATION_FROM_EMAIL).
//   - Different Reply-To: routed to reply+<convId>@<INBOX_EMAIL_REPLY_DOMAIN>
//     so future inbound webhooks can thread replies back to the right
//     conversation.
//   - Capability-gated: every send checks (a) the lead has an email
//     address, (b) the Postmark token + INBOX_EMAIL_FROM are configured,
//     (c) the workspace hasn't blown its daily cap.
//   - Audit trail: every attempt writes a Message row with
//     deliveryStatus SENDING before the provider call, then flips to
//     SENT or FAILED. Crashes mid-call leave an inspectable row.
//
// No retries here — the route handler returns the error; the user
// re-clicks Send. A background queue can be added later without
// changing the contract.

import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { checkRateLimit } from "../sites/rateLimit.js";

// Lazy-load the postmark SDK so unit tests that mock prisma + this
// module don't drag in the real network client.
let postmarkClient = null;
async function getPostmarkClient() {
  if (postmarkClient) return postmarkClient;
  if (!env.POSTMARK_SERVER_TOKEN) return null;
  const postmark = await import("postmark");
  postmarkClient = new postmark.ServerClient(env.POSTMARK_SERVER_TOKEN);
  return postmarkClient;
}

// Test seam — production code shouldn't reach this. Lets the
// outbound test file inject a stub that captures the payload.
export function __setPostmarkClientForTest(stub) {
  postmarkClient = stub;
}

// ── Capability resolution ──────────────────────────────────────────────

/**
 * Why a conversation can't send email right now. Returns null when
 * sending is available. The reason string is surfaced to the UI so
 * the composer can render an honest disabled state.
 */
export function emailSendBlocker({ conversation, contact, providerConfigured }) {
  if (!providerConfigured) {
    return "Outbound email is not configured for this workspace yet.";
  }
  if (!contact?.email) {
    return "This lead has no email address on file.";
  }
  if (conversation?.spam) {
    return "Conversation is marked as spam — unmark before sending.";
  }
  return null;
}

/**
 * Server-side capability snapshot for a single conversation. Used by
 * getConversation to surface replyCapabilities to the UI; the route
 * handler also calls it before sending so the UI can't be fooled
 * into thinking it's allowed.
 */
export function emailCapabilityFor({ conversation, contact }) {
  const providerConfigured = isEmailProviderConfigured();
  const blocker = emailSendBlocker({ conversation, contact, providerConfigured });
  return {
    available: blocker === null,
    reason: blocker,
  };
}

export function isEmailProviderConfigured() {
  return Boolean(env.POSTMARK_SERVER_TOKEN && env.INBOX_EMAIL_FROM);
}

// ── Helpers ────────────────────────────────────────────────────────────

// Workspaces don't have their own verified Postmark sender yet, so
// every send uses the shared INBOX_EMAIL_FROM mailbox. We override
// the display name to "<Workspace> (via Squadpitch) <inbox@…>" so
// the lead sees who's actually reaching out. Falls back to the bare
// env value when no Client.name is known.
export function buildFromAddress(env_, clientName) {
  const base = env_.INBOX_EMAIL_FROM;
  if (!base) return null;
  const safeName =
    typeof clientName === "string" && clientName.trim().length > 0
      ? clientName.trim().replace(/[<>"@]/g, "")
      : null;
  if (!safeName) return base;
  // Pull the address out of "Name <addr>" or use the bare addr.
  const match = base.match(/^(.+?)\s*<(.+?)>$/);
  const addr = match ? match[2] : base;
  return `${safeName} (via Squadpitch) <${addr}>`;
}

// Reply-To: routed inbound address. Future inbound webhook parses
// reply+<convId>@<INBOX_EMAIL_REPLY_DOMAIN> and re-threads to the
// originating Conversation. Returns null when no reply domain is set
// (we still send, just without inbound routing).
export function buildReplyToAddress(env_, conversationId) {
  if (!env_.INBOX_EMAIL_REPLY_DOMAIN) return null;
  return `reply+${conversationId}@${env_.INBOX_EMAIL_REPLY_DOMAIN}`;
}

// Deterministic Message-ID so a future Reply we receive can carry
// In-Reply-To: <this> and we know which thread it belongs to.
export function buildMessageId(env_, conversationId, messageId) {
  const domain =
    env_.INBOX_EMAIL_REPLY_DOMAIN ||
    // Fall back to the inbox-from address's domain so the header is
    // still valid even without a reply domain.
    (env_.INBOX_EMAIL_FROM?.match(/@([^>\s]+)/)?.[1] ?? "squadpitch.com");
  return `<conv-${conversationId}-msg-${messageId}@${domain}>`;
}

export function buildSubject({ override, clientName }) {
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim().slice(0, 998);
  }
  const name = clientName?.trim();
  return name ? `Re: Your inquiry to ${name}` : "Re: Your inquiry";
}

// Convert a plain-text body into a very simple HTML body. Newlines
// become <br>. We don't try to render markdown; the composer is
// plain-text today.
export function plainToHtml(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  const escaped = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\r?\n/g, "<br>\n");
}

// ── The send call ──────────────────────────────────────────────────────

const DEFAULT_DAILY_CAP_SCOPE = "inbox-email";

/**
 * Send an Inbox reply via email. Returns the persisted Message row
 * on success or throws a typed error for the route handler to map
 * to an HTTP status.
 *
 * Throws errors with `.status` and `.code` set:
 *   404 CONVERSATION_NOT_FOUND — wrong workspace or no such conv
 *   412 EMAIL_NOT_AVAILABLE    — capability blocker (see emailSendBlocker)
 *   429 RATE_LIMITED           — workspace exceeded its daily cap
 *   502 PROVIDER_FAILED        — Postmark accepted the request but reported failure
 *   503 PROVIDER_UNREACHABLE   — Postmark call raised
 */
export async function sendInboxEmail(clientId, conversationId, userId, { body, subject, fromSuggestionId } = {}) {
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    const err = new Error("Body is required");
    err.status = 400;
    err.code = "BODY_REQUIRED";
    throw err;
  }

  // Defense in depth — the route runs requireClientOwner, but the
  // service scopes by clientId anyway so a forgotten guard can't
  // cross workspaces.
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    include: { contact: true },
  });
  if (!conversation) {
    const err = new Error("Conversation not found");
    err.status = 404;
    err.code = "CONVERSATION_NOT_FOUND";
    throw err;
  }

  const providerConfigured = isEmailProviderConfigured();
  const blocker = emailSendBlocker({
    conversation,
    contact: conversation.contact,
    providerConfigured,
  });
  if (blocker) {
    const err = new Error(blocker);
    err.status = 412;
    err.code = providerConfigured ? "EMAIL_NOT_AVAILABLE" : "EMAIL_NOT_CONFIGURED";
    throw err;
  }

  // Per-workspace daily cap. Sliding-window via Redis (sites
  // rateLimit helper). 24h window keyed by clientId.
  const cap = env.INBOX_EMAIL_DAILY_CAP ?? 50;
  const rl = await checkRateLimit(DEFAULT_DAILY_CAP_SCOPE, clientId, cap, 24 * 60 * 60);
  if (!rl.allowed) {
    const err = new Error(
      `Workspace daily email cap (${cap}) reached. Try again in ${Math.ceil(rl.retryAfterSec / 3600)}h.`,
    );
    err.status = 429;
    err.code = "RATE_LIMITED";
    err.retryAfterSec = rl.retryAfterSec;
    throw err;
  }

  // Look up the workspace name for the From: display name. Light
  // cost — one extra query — and lets the lead see who's writing.
  const client = await prisma.client
    .findUnique({ where: { id: clientId }, select: { name: true } })
    .catch(() => null);

  // Step 1: create the Message row in SENDING state BEFORE the
  // provider call. An in-flight crash leaves an auditable row at
  // SENDING that ops can flip to FAILED manually if Postmark never
  // delivered.
  const messageRow = await prisma.message.create({
    data: {
      conversationId,
      party: "WORKSPACE",
      channel: "EMAIL",
      body: body.trim(),
      authorUserId: userId,
      fromSuggestionId: fromSuggestionId ?? null,
      deliveryStatus: "SENDING",
      lastAttemptedAt: new Date(),
    },
  });

  const fromHeader = buildFromAddress(env, client?.name);
  const replyToHeader = buildReplyToAddress(env, conversationId);
  const messageIdHeader = buildMessageId(env, conversationId, messageRow.id);
  const subjectLine = buildSubject({ override: subject, clientName: client?.name });

  const postmarkPayload = {
    From: fromHeader,
    To: conversation.contact.email,
    Subject: subjectLine,
    HtmlBody: plainToHtml(body),
    TextBody: body.trim(),
    MessageStream: env.POSTMARK_MESSAGE_STREAM || "outbound",
    // Postmark sets its own Message-ID when omitted, but providing
    // our own gives us deterministic threading on future replies.
    Headers: [{ Name: "Message-ID", Value: messageIdHeader }],
    ...(replyToHeader ? { ReplyTo: replyToHeader } : {}),
  };

  // Step 2: provider call. Failure modes:
  //   - Network/timeout — caught here, mark FAILED, throw 503
  //   - Postmark rejects (ErrorCode != 0) — mark FAILED, throw 502
  //   - Success — mark SENT, set providerMessageId
  const pm = await getPostmarkClient();
  if (!pm) {
    // Provider lazily unconfigured between the capability check and
    // here (env reload?). Mark FAILED so the audit row reflects it.
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: "Postmark client unavailable at send time",
      },
    });
    const err = new Error("Email provider is unavailable");
    err.status = 503;
    err.code = "PROVIDER_UNREACHABLE";
    throw err;
  }

  let providerResponse;
  try {
    providerResponse = await pm.sendEmail(postmarkPayload);
  } catch (rawErr) {
    const reason = rawErr?.message || String(rawErr).slice(0, 1000);
    await prisma.message.update({
      where: { id: messageRow.id },
      data: { deliveryStatus: "FAILED", errorReason: reason },
    });
    const err = new Error("Email provider call failed");
    err.status = 503;
    err.code = "PROVIDER_UNREACHABLE";
    err.providerError = reason;
    throw err;
  }

  // Postmark's API returns ErrorCode in the body. A 200 with
  // ErrorCode != 0 is still a logical failure (rejected sender,
  // unsubscribed recipient, etc.). Treat as FAILED.
  if (providerResponse?.ErrorCode && providerResponse.ErrorCode !== 0) {
    const reason = providerResponse.Message || `ErrorCode ${providerResponse.ErrorCode}`;
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: `${providerResponse.ErrorCode}: ${reason}`,
      },
    });
    const err = new Error(reason);
    err.status = 502;
    err.code = "PROVIDER_FAILED";
    err.providerError = reason;
    throw err;
  }

  // Step 3: mark SENT + stamp providerMessageId. Also re-sort the
  // conversation so the inbox list shows the latest activity.
  const sentMessage = await prisma.message.update({
    where: { id: messageRow.id },
    data: {
      deliveryStatus: "SENT",
      providerMessageId: providerResponse?.MessageID ?? null,
      externalMessageId: messageIdHeader,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: sentMessage.createdAt,
      lastMessageFrom: "WORKSPACE",
      workspaceReadAt: sentMessage.createdAt,
      contact: {
        update: { status: conversation.contact.status === "NEW" ? "ENGAGED" : conversation.contact.status },
      },
    },
  });

  // Mark the source AI suggestion accepted, if any. Fire-and-forget;
  // a failure here shouldn't bubble — the send already succeeded.
  if (fromSuggestionId) {
    await prisma.aIReplySuggestion
      .updateMany({
        where: { id: fromSuggestionId, conversationId },
        data: { acceptedAt: new Date() },
      })
      .catch(() => {});
  }

  return sentMessage;
}
