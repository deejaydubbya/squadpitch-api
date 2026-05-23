// Authenticated SquadInbox dashboard service.
//
// All operations are workspace-scoped — every helper takes
// clientId and filters every query by it. The route handler
// pre-verifies the caller owns the workspace via
// requireClientOwner, but the per-query scoping is defense in
// depth so a forgotten guard can't cross workspaces.

import { prisma } from "../../prisma.js";
import { loadClientGenerationContext } from "../studio/generation/clientOrchestrator.js";
import { generateStructuredContent } from "../studio/generation/openai.provider.js";
import { trackAiUsage } from "../billing/aiUsageTracking.service.js";
import { buildLanguageInstructions } from "../studio/generation/languageInstructions.js";
import { resolveLanguage } from "../studio/generation/resolveLanguage.js";

// ── Conversation list + detail ─────────────────────────────────────────

export async function listConversations(clientId, { status, spam, search, limit, cursor }) {
  const where = { clientId };
  if (status) where.status = status;
  if (spam !== undefined) where.spam = spam;
  if (search) {
    where.OR = [
      { contact: { email: { contains: search, mode: "insensitive" } } },
      { contact: { phone: { contains: search } } },
      { contact: { name: { contains: search, mode: "insensitive" } } },
    ];
  }
  const rows = await prisma.conversation.findMany({
    where,
    orderBy: { lastMessageAt: "desc" },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    include: {
      contact: {
        select: { id: true, email: true, phone: true, name: true, status: true },
      },
      // Last message preview for the inbox list. Only the body
      // and party so the payload stays small.
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, body: true, party: true, createdAt: true },
      },
    },
  });
  const nextCursor = rows.length > limit ? rows.pop().id : null;
  return { conversations: rows.map(decorateUnread), nextCursor };
}

export async function getConversation(clientId, conversationId) {
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    include: {
      contact: true,
      messages: { orderBy: { createdAt: "asc" } },
      notes: { orderBy: { createdAt: "desc" } },
      aiReplies: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!row) return null;
  // Stamp workspaceReadAt as a side effect of viewing — flips
  // unread to read. Caller decides whether to honor this via the
  // dedicated PATCH; here we just decorate without writing.
  return decorateUnread(row);
}

function decorateUnread(conversation) {
  const lastFromContact = conversation.lastMessageFrom === "CONTACT";
  const readAt = conversation.workspaceReadAt;
  const unread =
    lastFromContact &&
    (!readAt ||
      new Date(readAt).getTime() < new Date(conversation.lastMessageAt).getTime());
  return { ...conversation, unread };
}

// ── Conversation update ────────────────────────────────────────────────

const ALLOWED_PATCH_FIELDS = [
  "status",
  "spam",
  "assignedUserId",
  // `markRead: true` is a virtual field that maps to
  // workspaceReadAt=now(). Letting the caller pass workspaceReadAt
  // directly invites time-spoofing.
  "markRead",
];

export async function updateConversation(clientId, conversationId, patch) {
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    select: { id: true },
  });
  if (!row) {
    const err = new Error("Conversation not found");
    err.status = 404;
    err.code = "CONVERSATION_NOT_FOUND";
    throw err;
  }

  const data = {};
  for (const key of ALLOWED_PATCH_FIELDS) {
    if (patch[key] === undefined) continue;
    if (key === "markRead") {
      if (patch.markRead === true) data.workspaceReadAt = new Date();
      continue;
    }
    data[key] = patch[key];
  }

  return prisma.conversation.update({
    where: { id: conversationId },
    data,
  });
}

// ── Notes ──────────────────────────────────────────────────────────────

export async function createNote(clientId, conversationId, authorUserId, body) {
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    select: { id: true },
  });
  if (!row) {
    const err = new Error("Conversation not found");
    err.status = 404;
    err.code = "CONVERSATION_NOT_FOUND";
    throw err;
  }
  return prisma.conversationNote.create({
    data: {
      conversationId,
      authorUserId,
      body,
    },
  });
}

// ── Manual outbound message log ────────────────────────────────────────
//
// Since outbound delivery (email/SMS) is deferred, MVP lets users
// LOG that they replied (e.g. they emailed the lead from their
// inbox, or texted them). Stamps party=WORKSPACE +
// channel=MANUAL_LOG so the thread shows the chronology.

export async function logManualMessage(
  clientId,
  conversationId,
  authorUserId,
  { body, channel = "MANUAL_LOG", fromSuggestionId },
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    select: { id: true },
  });
  if (!conversation) {
    const err = new Error("Conversation not found");
    err.status = 404;
    err.code = "CONVERSATION_NOT_FOUND";
    throw err;
  }
  const message = await prisma.message.create({
    data: {
      conversationId,
      party: "WORKSPACE",
      channel,
      body,
      authorUserId,
      fromSuggestionId: fromSuggestionId ?? null,
    },
  });

  // Update the conversation's last-message stamps so the inbox
  // re-sorts on the next read + so the contact's "unread" state
  // for the workspace clears.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: message.createdAt,
      lastMessageFrom: "WORKSPACE",
      workspaceReadAt: message.createdAt,
      // Auto-promote contact status NEW → ENGAGED on first reply.
      // Cheap signal; user can override.
      contact: {
        update: {
          status: "ENGAGED",
        },
      },
    },
  });

  // If the message was composed from an AI suggestion, mark the
  // suggestion as accepted so we can later measure usefulness.
  if (fromSuggestionId) {
    await prisma.aIReplySuggestion
      .updateMany({
        where: { id: fromSuggestionId, conversationId },
        data: { acceptedAt: new Date() },
      })
      .catch(() => {});
  }

  return message;
}

// ── AI reply generation ────────────────────────────────────────────────

const AI_REPLY_SCHEMA = {
  name: "inbox_reply",
  schema: {
    type: "object",
    properties: {
      body: { type: "string", minLength: 1, maxLength: 2000 },
      tone: { type: "string", maxLength: 40 },
    },
    required: ["body"],
    additionalProperties: false,
  },
  // Non-strict for the same reason as the sites generator —
  // strict mode insists on `required` listing every property,
  // which doesn't add value here.
  strict: false,
};

/**
 * Generate one reply suggestion for the most recent inbound
 * message on a conversation. Returns the persisted suggestion
 * row.
 *
 * Never auto-sends — the row lives in ai_reply_suggestions until
 * the user explicitly calls logManualMessage with the
 * fromSuggestionId.
 */
export async function generateAiReply(
  clientId,
  conversationId,
  userId,
  { tone = "professional", language } = {},
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    include: {
      contact: true,
      messages: { orderBy: { createdAt: "desc" }, take: 6 },
    },
  });
  if (!conversation) {
    const err = new Error("Conversation not found");
    err.status = 404;
    err.code = "CONVERSATION_NOT_FOUND";
    throw err;
  }

  const lastInbound = conversation.messages.find((m) => m.party === "CONTACT");
  if (!lastInbound) {
    const err = new Error("No inbound message to reply to");
    err.status = 400;
    err.code = "NO_INBOUND_MESSAGE";
    throw err;
  }

  // Load brand + voice context so the reply matches the
  // workspace's voice.
  const ctx = await loadClientGenerationContext(clientId);

  // Page + campaign metadata (light-weight — just names) so the
  // reply can reference what the lead was looking at.
  const [page, campaign] = await Promise.all([
    conversation.pageId
      ? prisma.sitePage.findUnique({
          where: { id: conversation.pageId },
          select: { title: true, description: true, language: true },
        })
      : null,
    conversation.campaignId
      ? prisma.campaign.findUnique({
          where: { id: conversation.campaignId },
          select: { name: true, campaignType: true, language: true },
        })
      : null,
  ]);

  // Phase 1 multilingual — resolve via request →
  // conversation.defaultReplyLanguage → page.language (the lead
  // landed on it) → campaign.language → contentPreferences →
  // client → "en". The page-language fallback handles the common
  // case where a Spanish landing page collected a Spanish lead
  // and the agent hasn't set a per-conversation reply language.
  const resolvedLanguage = resolveLanguage({
    requestedLanguage: language ?? conversation.defaultReplyLanguage ?? page?.language ?? campaign?.language,
    contentPreferences: ctx.contentPreferences,
    client: ctx.client,
  });

  const systemPrompt = buildAiReplySystemPrompt({ ctx, tone, language: resolvedLanguage });
  const userPrompt = buildAiReplyUserPrompt({
    conversation,
    contact: conversation.contact,
    lastInbound,
    history: conversation.messages.reverse(),
    page,
    campaign,
  });

  const result = await generateStructuredContent({
    systemPrompt,
    userPrompt,
    taskType: "generation",
    responseFormat: { type: "json_schema", json_schema: AI_REPLY_SCHEMA },
    temperature: 0.7,
    timeoutMs: 30_000,
  });

  const body = trimString(result.parsed?.body, 2000);
  if (!body) {
    const err = new Error("AI returned empty body");
    err.status = 502;
    err.code = "AI_EMPTY";
    throw err;
  }

  // Persist the suggestion before fire-and-forget telemetry so
  // the response we return matches the DB row.
  const suggestion = await prisma.aIReplySuggestion.create({
    data: {
      conversationId,
      forMessageId: lastInbound.id,
      body,
      tone: trimString(result.parsed?.tone, 40) || tone,
      model: result.model,
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
      language: resolvedLanguage,
    },
  });

  // Lump under GENERATE_POST until a dedicated enum value lands.
  // metadata.source = "inbox_reply" disambiguates.
  trackAiUsage({
    userId,
    clientId,
    actionType: "GENERATE_POST",
    model: result.model,
    promptTokens: result.usage?.prompt_tokens ?? 0,
    completionTokens: result.usage?.completion_tokens ?? 0,
    metadata: { source: "inbox_reply", conversationId, tone },
  });

  return suggestion;
}

function buildAiReplySystemPrompt({ ctx, tone, language }) {
  const brandName = ctx.client?.name ?? "the business";
  const voice = ctx.voice ?? null;
  const brand = ctx.brand ?? null;
  const lines = [
    `You write a single reply on behalf of ${brandName} to a lead who came in via the website.`,
    `Tone: ${tone}. Keep it short (1–3 sentences), warm, specific, and never make up facts.`,
  ];
  if (brand?.tagline) lines.push(`Brand tagline: ${brand.tagline}`);
  if (brand?.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  if (voice?.tone) lines.push(`Voice tone: ${voice.tone}`);
  if (voice?.style) lines.push(`Voice style: ${voice.style}`);
  lines.push("");
  lines.push("Output rules:");
  lines.push("- Respond ONLY with JSON matching the supplied schema.");
  lines.push("- Address the lead by name if their name is provided.");
  lines.push("- Acknowledge the specific page/topic they came from when known.");
  lines.push("- End with a concrete next step (a question, an offer, a meeting).");
  lines.push("- Don't sign off with anything more than a first name; we'll add the workspace's preferred sign-off.");
  const langDirective = buildLanguageInstructions(language);
  if (langDirective) {
    lines.push("");
    lines.push(langDirective);
  }
  return lines.join("\n");
}

function buildAiReplyUserPrompt({ contact, lastInbound, history, page, campaign }) {
  const lines = [
    "# Lead context",
    "",
    `**Name:** ${contact.name ?? "(not provided)"}`,
    `**Email:** ${contact.email ?? "(not provided)"}`,
    `**Phone:** ${contact.phone ?? "(not provided)"}`,
    `**Status:** ${contact.status}`,
  ];
  if (page) {
    lines.push("", `**Came from page:** ${page.title}`);
    if (page.description) lines.push(`Page description: ${page.description}`);
  }
  if (campaign) {
    lines.push("", `**Linked campaign:** ${campaign.name} (${campaign.campaignType})`);
  }
  lines.push("", "# Their latest message");
  lines.push("", lastInbound.body || "(no body — form submission only)");
  if (Array.isArray(history) && history.length > 1) {
    lines.push("", "# Earlier in the thread");
    for (const m of history.slice(0, -1)) {
      lines.push(`- [${m.party}] ${truncate(m.body, 240)}`);
    }
  }
  lines.push("");
  lines.push("Draft a single reply. JSON only.");
  return lines.join("\n");
}

function trimString(s, max) {
  if (typeof s !== "string") return "";
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function truncate(s, max) {
  if (typeof s !== "string") return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── Stats for dashboard widget ─────────────────────────────────────────

export async function getInboxStats(clientId) {
  const [unreadCount, openCount] = await Promise.all([
    prisma.conversation.count({
      where: {
        clientId,
        spam: false,
        lastMessageFrom: "CONTACT",
        OR: [
          { workspaceReadAt: null },
          { workspaceReadAt: { lt: prisma.conversation.fields.lastMessageAt } },
        ],
      },
    }),
    prisma.conversation.count({
      where: { clientId, status: "OPEN", spam: false },
    }),
  ]);
  return { unreadCount, openCount };
}
