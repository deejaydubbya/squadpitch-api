// SquadInbox inbound — Postmark inbound webhook parser.
//
// Counterpart to inbox.outbound.email.service.js. When the lead
// replies to an Inbox email, Postmark POSTs the parsed payload to
// /api/v1/webhooks/postmark/inbound. This service extracts the
// conversation id from the routed reply address, validates it,
// and persists a CONTACT-side EMAIL message in the thread.
//
// Safety contracts (mirrored from the prompt):
//   - Never create a Contact from an inbound reply. Replies must
//     attach to an existing Conversation; if there's no match, we
//     silently 200 so Postmark stops retrying without leaking
//     tenant data.
//   - Never auto-send anything. We persist + update; the workspace
//     user has to compose any onward reply themselves.
//   - Idempotent on the Postmark MessageID — re-deliveries don't
//     duplicate the thread.
//   - Cross-tenant: the only conv-id input we trust is the routed
//     address Postmark received. The webhook payload's "workspace"
//     or "clientId" fields (if any) are ignored.

import { prisma } from "../../prisma.js";

// ── Conversation-id extraction ─────────────────────────────────────────

/**
 * Pull the conversation id out of a Postmark inbound payload.
 * Order of preference (cheapest + most reliable first):
 *   1. MailboxHash — Postmark parses "reply+abc@…" into hash="abc".
 *   2. OriginalRecipient — exact routed address ahead of any
 *      forwarding.
 *   3. To / ToFull — the recipient list. Each entry can be a
 *      string ("reply+abc@…") or {Email, Name}.
 * Returns null when no candidate matches the reply+<id>@ pattern.
 */
export function extractConversationId(payload) {
  if (typeof payload?.MailboxHash === "string" && payload.MailboxHash.length > 0) {
    return payload.MailboxHash.trim();
  }

  const candidates = [];
  if (typeof payload?.OriginalRecipient === "string") candidates.push(payload.OriginalRecipient);
  if (Array.isArray(payload?.ToFull)) {
    for (const t of payload.ToFull) {
      if (typeof t?.Email === "string") candidates.push(t.Email);
    }
  }
  if (typeof payload?.To === "string") {
    candidates.push(...payload.To.split(",").map((s) => s.trim()));
  }
  if (Array.isArray(payload?.Recipients)) {
    candidates.push(...payload.Recipients.filter((s) => typeof s === "string"));
  }

  // Routed inbox address: reply+<cuid>@<reply-domain>
  // cuid characters are [a-z0-9]; we accept that range so an
  // address from a different system can't slip through.
  const re = /^reply\+([a-z0-9]+)@/i;
  for (const addr of candidates) {
    if (typeof addr !== "string") continue;
    const match = re.exec(addr.trim());
    if (match) return match[1];
  }
  return null;
}

// ── Body extraction + cleanup ──────────────────────────────────────────

const MAX_BODY_CHARS = 32_000;

/**
 * Pull a sensible plain-text body out of the inbound payload.
 * Prefers TextBody; falls back to a safely stripped HtmlBody.
 * When neither is usable, emits an attachment-stub placeholder.
 */
export function extractBody(payload) {
  if (typeof payload?.TextBody === "string" && payload.TextBody.trim()) {
    return stripQuotedReply(payload.TextBody.trim()).slice(0, MAX_BODY_CHARS);
  }
  if (typeof payload?.HtmlBody === "string" && payload.HtmlBody.trim()) {
    return htmlToText(payload.HtmlBody).slice(0, MAX_BODY_CHARS);
  }
  if (Array.isArray(payload?.Attachments) && payload.Attachments.length > 0) {
    return "[Email reply received with attachments]";
  }
  return "[Empty email reply]";
}

// Very conservative HTML-to-text. We DON'T need real rendering —
// just want to strip the structure so the workspace user can read
// what the lead actually wrote. Anything that looks like a script
// or style block is dropped entirely (defense against a hostile
// inbound payload, even though Postmark already sanitizes).
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Best-effort quoted-thread stripper. We cut at the first line
// that looks like a quote header ("On ... wrote:", "From: …", or
// "----- Original Message -----"). Trailing "> "-prefixed lines
// also get dropped. Not perfect — clients vary wildly — but good
// enough that the workspace user mostly sees the new content.
export function stripQuotedReply(text) {
  const lines = String(text).split(/\r?\n/);
  const cutPatterns = [
    /^On .+ wrote:?\s*$/i,
    /^From:\s.+/i,
    /^-+\s*Original Message\s*-+$/i,
    /^_{5,}$/, // some clients emit a long underscore divider
  ];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (cutPatterns.some((p) => p.test(t))) {
      return lines.slice(0, i).join("\n").trimEnd();
    }
  }
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim().startsWith(">")) end--;
  return lines.slice(0, end).join("\n").trimEnd();
}

// ── Payload sanitization ───────────────────────────────────────────────

/**
 * Build the payloadJson value stored on the Message row. Whitelist
 * only — never store raw HTML, base64 attachment content, full
 * MIME headers, or anything that could carry hostile script. We
 * keep just enough metadata for the UI to render "From: <name>"
 * and "Attached: <name.ext>".
 */
export function sanitizePayload(payload) {
  const out = {
    from: typeof payload?.From === "string" ? payload.From.slice(0, 320) : null,
    fromName: typeof payload?.FromName === "string" ? payload.FromName.slice(0, 240) : null,
    subject: typeof payload?.Subject === "string" ? payload.Subject.slice(0, 998) : null,
    date: typeof payload?.Date === "string" ? payload.Date.slice(0, 80) : null,
    messageId:
      typeof payload?.MessageID === "string"
        ? payload.MessageID.slice(0, 240)
        : typeof payload?.MessageId === "string"
          ? payload.MessageId.slice(0, 240)
          : null,
  };
  if (Array.isArray(payload?.Attachments) && payload.Attachments.length > 0) {
    out.attachments = payload.Attachments.slice(0, 20).map((a) => ({
      name: typeof a?.Name === "string" ? a.Name.slice(0, 240) : null,
      contentType:
        typeof a?.ContentType === "string" ? a.ContentType.slice(0, 120) : null,
      contentLength:
        typeof a?.ContentLength === "number" && Number.isFinite(a.ContentLength)
          ? a.ContentLength
          : null,
    }));
  }
  return out;
}

function parseDateOrNow(dateStr) {
  if (typeof dateStr !== "string" || !dateStr) return new Date();
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Process a Postmark inbound payload. Returns a result object
 * describing what happened — never throws on "logical" misses
 * (unknown conversation, missing routed id, etc.) so the route
 * handler can always return 200 to Postmark and prevent retry
 * loops on truly hopeless payloads.
 *
 * Throws only when the database call itself fails. The route
 * handler maps that to a 500 so Postmark will retry.
 */
export async function processInboundEmail(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "BAD_PAYLOAD" };
  }

  const conversationId = extractConversationId(payload);
  if (!conversationId) {
    return { ok: false, reason: "NO_CONVERSATION_HASH" };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, clientId: true, status: true, spam: true },
  });
  if (!conversation) {
    // Return ok so Postmark doesn't retry forever; the reason is
    // for our logs/audit. Don't leak existence.
    return { ok: false, reason: "CONVERSATION_NOT_FOUND" };
  }

  const externalId =
    typeof payload.MessageID === "string"
      ? payload.MessageID
      : typeof payload.MessageId === "string"
        ? payload.MessageId
        : null;

  // Idempotency. Postmark retries until 200; same payload arriving
  // twice MUST NOT duplicate the thread.
  if (externalId) {
    const dup = await prisma.message.findFirst({
      where: {
        conversationId,
        channel: "EMAIL",
        OR: [
          { providerMessageId: externalId },
          { externalMessageId: externalId },
        ],
      },
      select: { id: true },
    });
    if (dup) {
      return { ok: true, reason: "ALREADY_PROCESSED", messageId: dup.id };
    }
  }

  const body = extractBody(payload);
  const payloadJson = sanitizePayload(payload);
  const messageAt = parseDateOrNow(payload?.Date);

  const message = await prisma.message.create({
    data: {
      conversationId,
      party: "CONTACT",
      channel: "EMAIL",
      body,
      payloadJson,
      externalMessageId: externalId ?? null,
      providerMessageId: externalId ?? null,
      deliveryStatus: "SENT", // received side of the delivered envelope
      createdAt: messageAt,
    },
  });

  // Bump conversation activity. Workspace user becomes unread
  // again — we DELIBERATELY do NOT touch workspaceReadAt; the
  // existing decorateUnread() rule (lastMessageFrom=CONTACT &&
  // workspaceReadAt < lastMessageAt) will mark it unread.
  // If the conversation was CLOSED, reopen — a real reply means
  // the conversation isn't over yet.
  const convUpdate = {
    lastMessageAt: messageAt,
    lastMessageFrom: "CONTACT",
  };
  if (conversation.status === "CLOSED") convUpdate.status = "OPEN";
  await prisma.conversation.update({
    where: { id: conversationId },
    data: convUpdate,
  });

  return { ok: true, reason: "CREATED", messageId: message.id };
}
