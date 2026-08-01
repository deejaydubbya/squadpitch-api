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
  const details = emailCapabilityDetailsFor({ conversation, contact });
  return {
    available: details.canSend,
    reason: details.blockedReason,
    ...details,
  };
}

export function isEmailProviderConfigured() {
  return Boolean(env.POSTMARK_SERVER_TOKEN && env.INBOX_EMAIL_FROM);
}

export function emailOperationalStatus(env_ = env) {
  const providerConfigured = Boolean(
    env_.POSTMARK_SERVER_TOKEN && env_.INBOX_EMAIL_FROM,
  );
  return {
    providerConfigured,
    accountApproved: env_.POSTMARK_ACCOUNT_APPROVED === true,
    senderVerified: env_.POSTMARK_SENDER_VERIFIED === true,
    outboundStreamReady: Boolean(env_.POSTMARK_MESSAGE_STREAM),
    inboundRoutingReady: Boolean(
      env_.INBOX_EMAIL_REPLY_DOMAIN && env_.POSTMARK_INBOUND_WEBHOOK_SECRET,
    ),
    deliveryVerified: env_.POSTMARK_DELIVERY_VERIFIED === true,
  };
}

export function emailCapabilityDetailsFor({
  conversation,
  contact,
  channelEligible = true,
  env: env_ = env,
} = {}) {
  const status = emailOperationalStatus(env_);
  const recipientAvailable = Boolean(contact?.email);
  let blockedCode = null;
  let blockedReason = null;

  if (!channelEligible) {
    blockedCode = "EMAIL_CHANNEL_UNSUPPORTED";
    blockedReason = "Email is not supported for this conversation channel.";
  } else if (!status.providerConfigured) {
    blockedCode = "EMAIL_PROVIDER_NOT_CONFIGURED";
    blockedReason = "Email sending is not configured for Squadpitch.";
  } else if (!status.accountApproved) {
    blockedCode = "EMAIL_ACCOUNT_APPROVAL_PENDING";
    blockedReason =
      "Email sending is temporarily limited while the email provider account is being approved.";
  } else if (!status.senderVerified) {
    blockedCode = "EMAIL_SENDER_UNVERIFIED";
    blockedReason = "The configured sending address is not verified.";
  } else if (!status.outboundStreamReady) {
    blockedCode = "EMAIL_PROVIDER_UNAVAILABLE";
    blockedReason = "The email provider's outbound stream is unavailable.";
  } else if (!recipientAvailable) {
    blockedCode = "EMAIL_RECIPIENT_MISSING";
    blockedReason = "Add an email address to this contact before sending.";
  } else if (conversation?.spam) {
    blockedCode = "EMAIL_CONVERSATION_SPAM";
    blockedReason = "Conversation is marked as spam — unmark before sending.";
  }

  return {
    ...status,
    recipientAvailable,
    channelEligible,
    canSend: blockedCode === null,
    blockedCode,
    blockedReason,
  };
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

function emailDomainForLog(value) {
  const match = String(value ?? "").match(/@([^>\s]+)/);
  return match ? match[1].toLowerCase() : null;
}

// References-header size cap. RFC 5322 has no hard maximum, but
// most providers (Postmark included) reject headers >~8 KB total.
// Each Message-ID we emit is around 60 bytes including the angle
// brackets and space delimiter. Capping at ~25 keeps headers well
// under 2 KB while preserving meaningful threading. When the
// chain grows longer we keep the FIRST id (the thread origin —
// per RFC convention) plus the most recent N-1.
const MAX_REFERENCES = 25;

/**
 * Build the In-Reply-To + References headers for an outbound
 * Postmark send. Returns an array of { Name, Value } header
 * entries ready to spread into a Postmark Headers array.
 *
 *   - Empty when there are no prior EMAIL messages with an RFC
 *     Message-ID (i.e. this is the FIRST outbound in a thread).
 *   - In-Reply-To always points at the SINGLE most recent prior
 *     RFC Message-ID — that's what email clients use to nest
 *     individual replies.
 *   - References carries the FULL chain in chronological order,
 *     capped at MAX_REFERENCES. Clients use this for thread
 *     grouping when In-Reply-To doesn't resolve.
 *
 * Internal notes (ConversationNote) and AI suggestions
 * (AIReplySuggestion) are intentionally not in priorEmailMessages
 * — the caller queries only channel=EMAIL Messages.
 */
export function buildThreadingHeaders(priorEmailMessages) {
  if (!Array.isArray(priorEmailMessages) || priorEmailMessages.length === 0) {
    return [];
  }
  // Defensive: drop anything without an externalMessageId; sort
  // ascending so the most recent is last.
  const sorted = priorEmailMessages
    .filter((m) => typeof m?.externalMessageId === "string" && m.externalMessageId.length > 0)
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (sorted.length === 0) return [];

  const latest = sorted[sorted.length - 1];

  // Cap References: keep the original (first) message-id plus the
  // most recent (MAX_REFERENCES - 1) so the thread root is always
  // preserved even on very long chains. Some clients fall back to
  // References[0] when In-Reply-To doesn't match.
  let referenceIds = sorted.map((m) => m.externalMessageId);
  if (referenceIds.length > MAX_REFERENCES) {
    const head = referenceIds[0];
    const tail = referenceIds.slice(-(MAX_REFERENCES - 1));
    referenceIds = [head, ...tail];
  }

  return [
    { Name: "In-Reply-To", Value: latest.externalMessageId },
    { Name: "References", Value: referenceIds.join(" ") },
  ];
}

export function buildSubject({ override, clientName }) {
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim().slice(0, 998);
  }
  const name = clientName?.trim();
  return name ? `Re: Your inquiry to ${name}` : "Re: Your inquiry";
}

// Translate Postmark's raw ErrorCode + message into something a
// workspace owner can actually act on. The list is small on
// purpose — we only translate codes where the verbatim Postmark
// language is misleading or where the fix is non-obvious. Anything
// else falls through to the raw message, which Postmark writes
// pretty well.
//
// Reference: https://postmarkapp.com/developer/api/overview#error-codes
export function buildPostmarkUserMessage(errorCode, rawMessage) {
  // 412 — account / sender pending approval. The message Postmark
  // returns mentions "pending approval" and "share the same domain
  // as the 'From' address" — accurate but doesn't say WHERE to fix
  // it. Point them at the dashboard.
  if (errorCode === 412) {
    return (
      "Email can't be sent yet: your Postmark account is still in the " +
      "sandbox (\"Request Approval\") state, so it only accepts " +
      "recipients on your own verified domain. Approve the account in " +
      "the Postmark dashboard and try again."
    );
  }
  // 406 — inactive recipient (bounced before, spam-complained, etc.)
  if (errorCode === 406) {
    return "This recipient is inactive in Postmark (previous bounce or spam complaint). It can't receive new mail until reactivated.";
  }
  // 422 — invalid sender signature / domain not verified
  if (errorCode === 422) {
    return "The From address isn't verified in Postmark yet. Confirm the sender signature / domain DKIM + Return-Path records.";
  }
  // 405 — message is too large
  if (errorCode === 405) {
    return "This message is too large for Postmark. Trim attachments or body length.";
  }
  // 300 — invalid email address
  if (errorCode === 300) {
    return "Postmark rejected the recipient address as invalid.";
  }
  // Default: pass through Postmark's own message — usually clear.
  return rawMessage || "Email provider rejected the message.";
}

export function classifyPostmarkFailure(errorCode, httpStatus) {
  if (errorCode === 412)
    return { classification: "ACCOUNT_APPROVAL_PENDING", retryable: false };
  if (errorCode === 422)
    return { classification: "SENDER_UNVERIFIED", retryable: false };
  if (errorCode === 406)
    return { classification: "RECIPIENT_INACTIVE", retryable: false };
  if (errorCode === 300)
    return { classification: "RECIPIENT_INVALID", retryable: false };
  if (errorCode === 405)
    return { classification: "MESSAGE_TOO_LARGE", retryable: false };
  if (typeof httpStatus === "number" && httpStatus >= 500) {
    return { classification: "PROVIDER_UNAVAILABLE", retryable: true };
  }
  if (errorCode === null && (httpStatus === null || httpStatus === undefined)) {
    return { classification: "PROVIDER_UNAVAILABLE", retryable: true };
  }
  return { classification: "PROVIDER_REJECTED", retryable: false };
}

export function sanitizedProviderFailure(errorCode, httpStatus) {
  const detail = classifyPostmarkFailure(errorCode, httpStatus);
  const code =
    errorCode === null || errorCode === undefined
      ? "unknown"
      : String(errorCode);
  return `postmark:${detail.classification}:code=${code}:retryable=${detail.retryable}`;
}

// Convert a plain-text body into a very simple HTML body. Newlines
// become <br>. We don't try to render markdown; the composer is
// plain-text today.
export function plainToHtml(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return escapeHtml(s).replace(/\r?\n/g, "<br>\n");
}

// HTML-escape: every untrusted string going into the outbound HTML
// body MUST pass through this. Quote forms cover both element text
// AND attribute values so the helper is safe in either context.
export function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Outbound email body composition (context block) ─────────────────────
//
// The Message row stored in the DB carries ONLY the workspace user's
// reply text — that's what we render in the Inbox thread, so it has
// to stay clean. But the email actually sent to the lead also
// includes a quoted context section below the reply showing what's
// being replied to. Same pattern as Gmail/Outlook's quoted thread
// or any CRM's "Original inquiry" block.
//
// Returns { text, html } — these go straight into Postmark's
// TextBody / HtmlBody fields.

const QUOTE_SEPARATOR = "─".repeat(40);

function isFormSubmissionMessage(msg) {
  return msg && msg.channel === "FORM_SUBMISSION";
}

function buildQuoteHeader({ latestContactMessage, contact }) {
  // FORM_SUBMISSION messages get a "Original inquiry" header — the
  // first form submission isn't really a "reply", so framing it
  // as the original message is clearer to the lead. Subsequent
  // CONTACT messages (e.g. an email reply that came back via the
  // inbound webhook) use the standard "On <date>, <name> wrote:"
  // convention every email client recognizes.
  const name = contact?.name || contact?.email || contact?.phone || "the lead";
  if (isFormSubmissionMessage(latestContactMessage)) {
    return `Original inquiry from ${name}`;
  }
  const dateStr = formatHumanDate(latestContactMessage?.createdAt);
  return `On ${dateStr}, ${name} wrote:`;
}

function formatHumanDate(d) {
  if (!d) return "an earlier date";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "an earlier date";
  return date.toUTCString();
}

/**
 * Compose the outbound email's TextBody + HtmlBody. The user's
 * reply is rendered AS-IS at the top; below it a separator and
 * a quoted-context block referencing the latest CONTACT message
 * plus source page / campaign info when known.
 *
 * INPUTS are all untrusted strings — every interpolation goes
 * through escapeHtml when emitted as HTML.
 */
export function composeOutboundBody({
  userReply,
  latestContactMessage,
  contact,
  sourcePage,
  sourceCampaign,
}) {
  const cleanReply = String(userReply ?? "").trim();

  // No context to quote — emit just the user's reply. Still go
  // through plainToHtml for HTML escaping.
  if (!latestContactMessage) {
    return { text: cleanReply, html: plainToHtml(cleanReply) };
  }

  const header = buildQuoteHeader({ latestContactMessage, contact });
  const quotedBody = (latestContactMessage.body ?? "").trim();

  // ── Plain text version ──
  const textLines = [cleanReply, "", "", QUOTE_SEPARATOR, header];
  if (isFormSubmissionMessage(latestContactMessage)) {
    if (latestContactMessage.createdAt) {
      textLines.push(`Submitted on ${formatHumanDate(latestContactMessage.createdAt)}`);
    }
    if (sourcePage?.title) {
      textLines.push(`From page: ${sourcePage.title}`);
    } else if (sourcePage?.slug) {
      textLines.push(`From page: /${sourcePage.slug}`);
    }
  }
  if (sourceCampaign?.name) {
    textLines.push(`Campaign: ${sourceCampaign.name}`);
  }
  textLines.push("");
  // Prefix each line of the quoted body with "> " (standard email
  // quote convention). Empty lines stay as ">".
  const quotedLines = quotedBody.split(/\r?\n/).map((line) => (line.length > 0 ? `> ${line}` : ">"));
  textLines.push(...quotedLines);

  // ── HTML version ──
  const html = [];
  html.push(plainToHtml(cleanReply));
  html.push("<br><br>");
  html.push(
    '<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">',
  );
  html.push(
    '<div style="color: #6b7280; font-size: 13px; line-height: 1.5; margin-bottom: 12px;">',
  );
  html.push(`<strong>${escapeHtml(header)}</strong>`);
  if (isFormSubmissionMessage(latestContactMessage)) {
    if (latestContactMessage.createdAt) {
      html.push(
        `<br>Submitted on ${escapeHtml(formatHumanDate(latestContactMessage.createdAt))}`,
      );
    }
    if (sourcePage?.title) {
      html.push(`<br>From page: ${escapeHtml(sourcePage.title)}`);
    } else if (sourcePage?.slug) {
      html.push(`<br>From page: /${escapeHtml(sourcePage.slug)}`);
    }
  }
  if (sourceCampaign?.name) {
    html.push(`<br>Campaign: ${escapeHtml(sourceCampaign.name)}`);
  }
  html.push("</div>");
  html.push(
    '<blockquote style="margin: 0; padding: 8px 14px; border-left: 3px solid #d1d5db; color: #4b5563; font-size: 14px; line-height: 1.55;">',
  );
  html.push(plainToHtml(quotedBody));
  html.push("</blockquote>");

  return { text: textLines.join("\n"), html: html.join("\n") };
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
export async function sendInboxEmail(
  clientId,
  conversationId,
  userId,
  { body, subject, fromSuggestionId, idempotencyKey } = {},
) {
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

  // Idempotency pre-check. The web composer mints a fresh UUID per
  // Send click; a retried request (double-click, network retry,
  // server-restart-during-call) with the same key returns whatever
  // we already wrote rather than firing a second provider send.
  //
  // Branches:
  //   SENT      → return the existing Message (no-op retry, happy path)
  //   FAILED    → return the existing Message so the UI surfaces the
  //               failed state instead of duplicating it; a Retry
  //               click must mint a new key (the web client does)
  //   SENDING   → in-flight first attempt; 409 so the client can wait
  //               and refetch rather than start a parallel send
  //   anything else → return as-is (legacy SENT messages, etc.)
  if (idempotencyKey) {
    const existing = await prisma.message.findFirst({
      where: { conversationId, idempotencyKey },
    });
    if (existing) {
      if (existing.deliveryStatus === "SENDING") {
        const err = new Error("A send with this idempotency key is already in progress");
        err.status = 409;
        err.code = "SEND_IN_PROGRESS";
        throw err;
      }
      return existing;
    }
  }

  const emailCapability = emailCapabilityDetailsFor({
    conversation,
    contact: conversation.contact,
  });
  if (!emailCapability.canSend) {
    const err = new Error(emailCapability.blockedReason);
    err.status = 412;
    err.code = emailCapability.blockedCode;
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

  // Pre-send lookups (run in parallel):
  //   - Workspace name for the From: display
  //   - Latest CONTACT message (what we're replying to — quoted in
  //     the outbound body)
  //   - Source page + campaign (rendered in the context block when
  //     the latest CONTACT message is a FORM_SUBMISSION)
  //
  // Internal notes and AI suggestions are NEVER pulled here —
  // those stay workspace-private. Same goes for older WORKSPACE
  // messages (the lead already received those).
  const [client, latestContactMessage, sourcePage, sourceCampaign, priorEmailMessages] =
    await Promise.all([
      prisma.client
        .findUnique({ where: { id: clientId }, select: { name: true } })
        .catch(() => null),
      prisma.message.findFirst({
        where: { conversationId, party: "CONTACT" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          channel: true,
          body: true,
          createdAt: true,
        },
      }),
      conversation.pageId
        ? prisma.sitePage
            .findUnique({
              where: { id: conversation.pageId },
              select: { id: true, title: true, slug: true },
            })
            .catch(() => null)
        : Promise.resolve(null),
      conversation.campaignId
        ? prisma.campaign
            .findUnique({
              where: { id: conversation.campaignId },
              select: { id: true, name: true },
            })
            .catch(() => null)
        : Promise.resolve(null),
      // Prior EMAIL messages with an RFC Message-ID — drives the
      // In-Reply-To + References headers so email clients group
      // every outbound + inbound message into one thread. Scoped
      // strictly to channel=EMAIL so ConversationNotes and AI
      // suggestions never enter the threading graph.
      prisma.message.findMany({
        where: {
          conversationId,
          channel: "EMAIL",
          externalMessageId: { not: null },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, externalMessageId: true, createdAt: true },
        take: 25,
      }),
    ]);

  // Step 1: create the Message row in SENDING state BEFORE the
  // provider call. An in-flight crash leaves an auditable row at
  // SENDING that ops can flip to FAILED manually if Postmark never
  // delivered.
  // The composite unique (conversationId, idempotencyKey) means a
  // concurrent second request that slipped past the pre-check
  // (race window) will throw P2002 here. We catch it, refetch the
  // winner, and return it — same outcome as a serialized retry.
  let messageRow;
  try {
    messageRow = await prisma.message.create({
      data: {
        conversationId,
        party: "WORKSPACE",
        channel: "EMAIL",
        body: body.trim(),
        authorUserId: userId,
        fromSuggestionId: fromSuggestionId ?? null,
        idempotencyKey: idempotencyKey ?? null,
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
          const err = new Error("A send with this idempotency key is already in progress");
          err.status = 409;
          err.code = "SEND_IN_PROGRESS";
          throw err;
        }
        return racedWinner;
      }
    }
    throw createErr;
  }

  const fromHeader = buildFromAddress(env, client?.name);
  const replyToHeader = buildReplyToAddress(env, conversationId);
  const messageIdHeader = buildMessageId(env, conversationId, messageRow.id);
  const subjectLine = buildSubject({ override: subject, clientName: client?.name });

  // RFC threading headers (In-Reply-To + References). For the
  // FIRST outbound email in a conversation, priorEmailMessages is
  // empty → no headers added → recipient's email client treats it
  // as a new thread. For SUBSEQUENT emails, we point In-Reply-To
  // at the most recent prior EMAIL message and roll the full
  // chain into References, capped so we don't overrun Postmark's
  // header-size limit.
  const threadingHeaders = buildThreadingHeaders(priorEmailMessages ?? []);

  // Compose the outbound body: user's reply + a quoted context
  // section showing the latest CONTACT message and (when it's a
  // FORM_SUBMISSION) the source page / campaign. Internal notes
  // and AI suggestions are NOT included — they were never loaded.
  const { text: textBody, html: htmlBody } = composeOutboundBody({
    userReply: body,
    latestContactMessage,
    contact: conversation.contact,
    sourcePage,
    sourceCampaign,
  });

  const postmarkPayload = {
    From: fromHeader,
    To: conversation.contact.email,
    Subject: subjectLine,
    HtmlBody: htmlBody,
    TextBody: textBody,
    MessageStream: env.POSTMARK_MESSAGE_STREAM || "outbound",
    // Postmark sets its own Message-ID when omitted, but providing
    // our own gives us deterministic threading on future replies.
    // In-Reply-To + References pin this message into the existing
    // RFC thread (when we have prior messages to reference).
    Headers: [
      { Name: "Message-ID", Value: messageIdHeader },
      ...threadingHeaders,
    ],
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
    // Postmark SDK throws on every HTTP 4xx/5xx as an ApiInputError
    // (or one of its subclasses). The thrown error carries:
    //   .code        — Postmark business ErrorCode (e.g. 412 for
    //                  pending-approval sandbox, 406 for inactive
    //                  recipient, etc.)
    //   .statusCode  — HTTP status (4xx/5xx)
    //   .message     — Postmark's diagnostic message
    // We distinguish "real provider rejection" (business state, map
    // to PROVIDER_FAILED 502 with the message surfaced to the user)
    // from "infrastructure unreachable" (network, timeout — map to
    // PROVIDER_UNREACHABLE 503 with generic copy).
    const postmarkErrorCode =
      typeof rawErr?.code === "number" ? rawErr.code : null;
    const httpStatus = rawErr?.statusCode ?? rawErr?.status;
    const errorName = rawErr?.name ?? "Error";
    const rawMessage = rawErr?.message || String(rawErr).slice(0, 1000);
    const safeFailure = sanitizedProviderFailure(postmarkErrorCode, httpStatus);

    console.error("[INBOX_OUTBOUND_EMAIL] Postmark sendEmail threw:", {
      messageId: messageRow.id,
      conversationId,
      clientId,
      fromDomain: emailDomainForLog(postmarkPayload.From),
      toDomain: emailDomainForLog(postmarkPayload.To),
      stream: postmarkPayload.MessageStream,
      errorName,
      errorClassification: safeFailure,
      errorCode: postmarkErrorCode,
      statusCode: httpStatus,
      stack: rawErr?.stack?.split("\n").slice(0, 5).join("\n"),
    });
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: safeFailure,
      },
    });

    // 4xx with a Postmark ErrorCode is a business rejection —
    // surface the message verbatim so the user knows what to do
    // (request account approval, fix sender signature, etc.).
    if (
      typeof httpStatus === "number" &&
      httpStatus >= 400 &&
      httpStatus < 500
    ) {
      const userFacing = buildPostmarkUserMessage(postmarkErrorCode, rawMessage);
      const err = new Error(userFacing);
      err.status = 502;
      err.code = "PROVIDER_FAILED";
      err.providerError = safeFailure;
      err.postmarkErrorCode = postmarkErrorCode;
      throw err;
    }

    // 5xx or thrown-without-status → real infrastructure issue.
    const err = new Error("Email provider is unreachable. Try again in a minute.");
    err.status = 503;
    err.code = "PROVIDER_UNREACHABLE";
    err.providerError = safeFailure;
    throw err;
  }

  // Postmark's API returns ErrorCode in the body. A 200 with
  // ErrorCode != 0 is still a logical failure (rejected sender,
  // unsubscribed recipient, etc.). Treat as FAILED.
  if (providerResponse?.ErrorCode && providerResponse.ErrorCode !== 0) {
    const reason = providerResponse.Message || `ErrorCode ${providerResponse.ErrorCode}`;
    const safeFailure = sanitizedProviderFailure(
      providerResponse.ErrorCode,
      400,
    );
    console.error("[INBOX_OUTBOUND_EMAIL] Postmark rejected:", {
      messageId: messageRow.id,
      conversationId,
      clientId,
      fromDomain: emailDomainForLog(postmarkPayload.From),
      toDomain: emailDomainForLog(postmarkPayload.To),
      stream: postmarkPayload.MessageStream,
      errorCode: providerResponse.ErrorCode,
      errorClassification: safeFailure,
    });
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: safeFailure,
      },
    });
    const err = new Error(
      buildPostmarkUserMessage(providerResponse.ErrorCode, reason),
    );
    err.status = 502;
    err.code = "PROVIDER_FAILED";
    err.providerError = safeFailure;
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
