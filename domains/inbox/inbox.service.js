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
import { emailCapabilityFor } from "./inbox.outbound.email.service.js";
import { getAvailableReplyActions } from "./inbox.replyActions.js";

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

  // Page + campaign summaries for source context in the Inbox UI.
  // No Prisma relations defined on Conversation for these FKs, so
  // we look them up manually with a tight select whitelist —
  // never include blocksJson, themeJson, or any other heavyweight
  // payload. Mirrors the lookup in generateAiReply().
  const [page, campaign] = await Promise.all([
    row.pageId
      ? prisma.sitePage.findUnique({
          where: { id: row.pageId },
          select: { id: true, title: true, slug: true, status: true },
        })
      : null,
    row.campaignId
      ? prisma.campaign.findUnique({
          where: { id: row.campaignId },
          select: {
            id: true,
            name: true,
            campaignType: true,
            status: true,
          },
        })
      : null,
  ]);

  // Reply-mode capabilities — what the composer is allowed to do.
  // Computed server-side so the UI can't be talked into showing
  // "Send email" when the lead has no email or the provider isn't
  // configured. Internal note + log-external are always available.
  const replyCapabilities = {
    email: emailCapabilityFor({ conversation: row, contact: row.contact }),
    logExternal: { available: true, reason: null },
    note: { available: true, reason: null },
  };

  // Channel-aware action list — richer surface than
  // replyCapabilities. Drives the redesigned composer which
  // renders modes from the server list rather than three
  // hard-coded tabs. Older UI continues to work off
  // replyCapabilities until it migrates.
  const availableReplyActions = getAvailableReplyActions(row);

  // Stamp workspaceReadAt as a side effect of viewing — flips
  // unread to read. Caller decides whether to honor this via the
  // dedicated PATCH; here we just decorate without writing.
  return decorateUnread({
    ...row,
    page,
    campaign,
    replyCapabilities,
    availableReplyActions,
  });
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
  { tone = "professional", channel = "email" } = {},
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

  // Source context — page (with content blocks + lineage),
  // campaign (with source data item link), originating
  // FormSubmission, and the underlying WorkspaceDataItem when
  // the page/campaign is sourced from a property or other data
  // asset. This is the fix for the "which home?" bug: previously
  // the model only saw the page title, so a price-question on a
  // property page got a generic "please specify" reply.
  const sourceContext = await loadAiReplyContext(conversation);

  const systemPrompt = buildAiReplySystemPrompt({
    ctx,
    tone,
    channel,
    sourceContext,
  });
  const userPrompt = buildAiReplyUserPrompt({
    conversation,
    contact: conversation.contact,
    lastInbound,
    history: conversation.messages.reverse(),
    sourceContext,
    channel,
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
    metadata: { source: "inbox_reply", conversationId, tone, channel },
  });

  return suggestion;
}

// ── Source context loader ──────────────────────────────────────────────
//
// Pulls every piece of context a salesperson would need to answer
// the lead's first question without asking the lead to repeat
// what the page already told them. Each lookup is independent so
// a missing relation (page deleted, no campaign, generic non-
// property data item) degrades silently to null.
export async function loadAiReplyContext(conversation) {
  const { pageId, campaignId, sourceFormSubmissionId } = conversation;

  const [page, campaign, submission] = await Promise.all([
    pageId
      ? prisma.sitePage.findUnique({
          where: { id: pageId },
          // blocksJson carries the actual content the lead saw on
          // the page — hero headlines, key_details items, paragraph
          // bodies, contact info. That IS the source of truth for
          // facts the lead might be asking about.
          select: {
            id: true,
            title: true,
            slug: true,
            description: true,
            sourceType: true,
            sourceId: true,
            pageGoal: true,
            seoDescription: true,
            blocksJson: true,
          },
        })
      : null,
    campaignId
      ? prisma.campaign.findUnique({
          where: { id: campaignId },
          select: {
            id: true,
            name: true,
            campaignType: true,
            status: true,
            // Campaign source columns use lowercase strings
            // (property/data_item/idea) — different from
            // SitePage.sourceType which uses uppercase enum values.
            sourceType: true,
            sourceDataItemId: true,
            sourceTitle: true,
            campaignIdea: true,
          },
        })
      : null,
    sourceFormSubmissionId
      ? prisma.formSubmission.findUnique({
          where: { id: sourceFormSubmissionId },
          select: {
            id: true,
            dataJson: true,
            createdAt: true,
            form: { select: { id: true, name: true } },
          },
        })
      : null,
  ]);

  // Resolve the underlying WorkspaceDataItem when the page or
  // campaign is sourced from one. Page lineage wins because the
  // page is what the lead actually saw; campaign is a fallback for
  // conversations that came in via a campaign without a dedicated
  // landing page.
  let dataItemId = null;
  if (page) {
    if (page.sourceType === "PROPERTY" || page.sourceType === "DATA_ITEM") {
      dataItemId = page.sourceId;
    }
  }
  if (!dataItemId && campaign) {
    if (campaign.sourceType === "property" || campaign.sourceType === "data_item") {
      dataItemId = campaign.sourceDataItemId;
    }
  }
  const dataItem = dataItemId
    ? await prisma.workspaceDataItem.findUnique({
        where: { id: dataItemId },
        select: {
          id: true,
          type: true,
          title: true,
          summary: true,
          dataJson: true,
          tags: true,
        },
      })
    : null;

  return { page, campaign, submission, dataItem };
}

// ── Prompt builders ────────────────────────────────────────────────────

function buildAiReplySystemPrompt({ ctx, tone, channel = "email", sourceContext }) {
  const brandName = ctx.client?.name ?? "the business";
  const voice = ctx.voice ?? null;
  const brand = ctx.brand ?? null;
  const hasSource = Boolean(
    sourceContext?.page || sourceContext?.campaign || sourceContext?.dataItem,
  );

  // Channel framing. Five surfaces:
  //   email          — real outbound email; warm greeting + sign-off
  //   reply          — logged-external; brief, no greeting/sign-off
  //   note           — internal team note; third-person
  //   public_comment — visible on the source platform to anyone who
  //                    can see the post. Shorter, safer, no PII.
  //   private_dm     — direct message; conversational like email,
  //                    but no greeting/sign-off (DMs read like chat)
  const lines = [];
  if (channel === "note") {
    lines.push(
      `You write a short internal note (1–3 sentences) for the ${brandName} team about a lead who came in via the website. The note will be visible only to the team, never sent to the lead.`,
      `Tone: ${tone}. Write in the third person, no greeting, no sign-off. Focus on what the lead asked and any facts the team needs to follow up well.`,
    );
  } else if (channel === "reply") {
    lines.push(
      `You draft a short outbound reply to a lead who came in via ${brandName}'s website. The workspace user will paste this into another tool (their CRM, their email client) so keep it minimal.`,
      `Tone: ${tone}. 1–3 sentences. No greeting, no sign-off — just the reply text itself.`,
    );
  } else if (channel === "public_comment") {
    // Public-surface reply (FB/IG comment). Whatever you write
    // here is visible to every viewer of the parent post.
    lines.push(
      `You draft a short public reply on behalf of ${brandName} to a comment on its social post. This reply will be visible to every viewer of the post — including people who are not the original commenter.`,
      `Tone: ${tone}. 1–2 sentences max. Never include the commenter's email, phone, address, or any private detail; offer to continue privately via DM or email if a specific question needs a longer answer.`,
    );
  } else if (channel === "private_dm") {
    lines.push(
      `You draft a private direct message on behalf of ${brandName} to a contact via social DM (Facebook Messenger or Instagram Direct). The lead messaged the page directly; only they will see this reply.`,
      `Tone: ${tone}. 1–3 sentences. DMs read like chat — no formal greeting, no sign-off. Mention the lead by first name if known.`,
    );
  } else if (channel === "review_reply") {
    // Public response to a Google review (or future Yelp / FB
    // Recommendation). This reply is visible to anyone browsing the
    // business listing — calm, appreciative, never defensive, and
    // never repeats anything personal the reviewer wrote about
    // themselves (name, location, what they bought).
    lines.push(
      `You draft a short public response on behalf of ${brandName} to a Google review. The response will appear directly under the review on the business's Google listing — visible to every future customer browsing it.`,
      `Tone: ${tone}. 1–3 sentences. Appreciative when the review is positive. Calm and solution-oriented when the review is negative — never defensive, never argumentative, never blame the reviewer.`,
    );
  } else {
    // email (default)
    lines.push(
      `You write a single email reply on behalf of ${brandName} to a lead who came in via the website.`,
      `Tone: ${tone}. Keep it short (1–3 sentences), warm, specific, sales-appropriate, and never invent facts.`,
    );
  }

  if (brand?.tagline) lines.push(`Brand tagline: ${brand.tagline}`);
  if (brand?.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  if (voice?.tone) lines.push(`Voice tone: ${voice.tone}`);
  if (voice?.style) lines.push(`Voice style: ${voice.style}`);

  lines.push("");
  lines.push("Output rules:");
  lines.push("- Respond ONLY with JSON matching the supplied schema.");
  if (channel === "email") {
    lines.push("- Address the lead by first name if their name is provided.");
  } else if (channel === "note") {
    lines.push("- Refer to the lead by name (or email/phone if no name) — never address them directly.");
  } else if (channel === "private_dm") {
    lines.push("- Address the lead by first name if their name is provided.");
  } else if (channel === "public_comment") {
    lines.push("- Address the commenter by first name only if their name is provided AND it's already public on the comment.");
    lines.push("- Never repeat or include the commenter's email, phone, address, or any contact detail in a public reply.");
    lines.push("- If the question can't be answered safely in public, invite them to continue via DM or email.");
  } else if (channel === "review_reply") {
    lines.push("- Thank the reviewer when the review is positive; acknowledge their concern when it's negative — without arguing or correcting them publicly.");
    lines.push("- Never repeat the reviewer's name, location, what they bought, or any other personal detail they shared — keep the reply generic enough that the next ten customers reading it don't see private info.");
    lines.push("- If the issue needs more investigation, invite the reviewer to reach out directly (email / phone) — never share private contact info in the public response.");
    lines.push("- Don't restate the star rating — the reader can already see it.");
  }

  if (hasSource) {
    // The core fix for context-blind replies: when the lead came in
    // from a specific page/property/campaign, their question almost
    // always refers to THAT thing — not some hypothetical other
    // listing. Don't ask "which home?" when the page tells you.
    lines.push(
      "- The lead arrived from a specific source page or campaign. Treat their question as referring to that source unless the message clearly references something else.",
    );
    if (channel === "note") {
      lines.push(
        "- Summarize what's known from the source facts so the team doesn't have to dig — quote the price, address, etc. directly.",
      );
      lines.push(
        "- If a fact the lead asked about is missing, flag it clearly so the team knows what to confirm.",
      );
    } else {
      lines.push(
        "- If the source facts below contain the answer, state it directly. If a specific fact is missing, say you will check and follow up — never ask the lead to clarify which property/page they meant.",
      );
    }
    lines.push(
      "- Never invent a price, address, square footage, or any other property detail. If it isn't in the source facts, treat it as unknown.",
    );
  } else if (channel !== "note") {
    lines.push(
      "- Acknowledge the specific page/topic they came from when known.",
    );
  }

  if (channel === "email") {
    lines.push(
      "- End with a concrete next step (answering a question, sending details, offering a showing or call).",
    );
    lines.push(
      "- Don't sign off with anything more than a first name; we'll add the workspace's preferred sign-off.",
    );
  } else if (channel === "reply") {
    lines.push(
      "- Land on a concrete next step but keep it tight — no greeting, no closing.",
    );
  } else if (channel === "public_comment") {
    lines.push(
      "- End with either a concrete answer, or an invitation to continue in DM/email if private detail is needed.",
    );
  } else if (channel === "private_dm") {
    lines.push(
      "- End with a concrete next step. No closing line — DMs end where the message ends.",
    );
  } else if (channel === "review_reply") {
    lines.push(
      "- Close warmly when the review is positive; close with a concrete next step (e.g. \"please reach out so we can make this right\") when it's negative.",
    );
    lines.push(
      "- Don't sign off — Google attaches the business identity automatically.",
    );
  } else {
    // note
    lines.push(
      "- End with a one-line suggested next action for the team (e.g. \"Confirm price and reply with showing times\").",
    );
  }
  return lines.join("\n");
}

function buildAiReplyUserPrompt({ contact, lastInbound, history, sourceContext, channel = "email" }) {
  const { page, campaign, submission, dataItem } = sourceContext ?? {};

  const lines = [
    "# Lead",
    "",
    `**Name:** ${contact.name ?? "(not provided)"}`,
    `**Email:** ${contact.email ?? "(not provided)"}`,
    `**Phone:** ${contact.phone ?? "(not provided)"}`,
    `**Status:** ${contact.status}`,
  ];

  if (page) {
    lines.push("", "# Source page");
    lines.push(`**Title:** ${page.title}`);
    if (page.pageGoal) lines.push(`**Page goal:** ${page.pageGoal}`);
    if (page.description) lines.push(`**Page description:** ${page.description}`);
    else if (page.seoDescription)
      lines.push(`**Page description:** ${page.seoDescription}`);

    // Render the key facts visible on the page itself — these are
    // exactly what the lead would have read before submitting.
    const pageFacts = collectPageFacts(page.blocksJson);
    if (pageFacts.length > 0) {
      lines.push("", "**Facts shown on the page:**");
      for (const fact of pageFacts) lines.push(`- ${fact}`);
    }
  }

  if (campaign) {
    lines.push("", "# Source campaign");
    lines.push(`**Name:** ${campaign.name}`);
    lines.push(`**Type:** ${campaign.campaignType}`);
    if (campaign.sourceTitle)
      lines.push(`**Campaign topic:** ${campaign.sourceTitle}`);
    if (campaign.campaignIdea)
      lines.push(`**Campaign idea:** ${truncate(campaign.campaignIdea, 400)}`);
  }

  if (dataItem) {
    lines.push("", "# Underlying source data");
    lines.push(`**Type:** ${dataItem.type}`);
    if (dataItem.title) lines.push(`**Title:** ${dataItem.title}`);
    if (dataItem.summary)
      lines.push(`**Summary:** ${truncate(dataItem.summary, 400)}`);
    const dataFacts = collectDataItemFacts(dataItem.dataJson);
    if (dataFacts.length > 0) {
      lines.push("", "**Known facts (use these directly when answering):**");
      for (const fact of dataFacts) lines.push(`- ${fact}`);
    } else {
      lines.push(
        "",
        "_(No structured facts on file. If the lead asks for a specific number — price, sqft, etc. — say you'll confirm and follow up rather than asking them to specify.)_",
      );
    }
  }

  if (submission?.dataJson && typeof submission.dataJson === "object") {
    const subFacts = collectSubmissionFacts(submission.dataJson);
    if (subFacts.length > 0) {
      lines.push("", "# Form answers from the lead");
      for (const f of subFacts) lines.push(`- ${f}`);
    }
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
  if (channel === "note") {
    lines.push("Write a single internal note for the team. JSON only.");
  } else if (channel === "public_comment") {
    lines.push("Draft a single short public reply. JSON only.");
  } else if (channel === "private_dm") {
    lines.push("Draft a single direct message. JSON only.");
  } else if (channel === "review_reply") {
    lines.push("Draft a single public review response. JSON only.");
  } else {
    lines.push("Draft a single reply. JSON only.");
  }
  return lines.join("\n");
}

// ── Prompt assembly helpers ────────────────────────────────────────────

// Pull "Label: value" facts out of the page's structured blocks so
// the model can see the same numbers the lead saw. We focus on
// blocks that carry user-readable copy; ignore image/gallery blocks.
function collectPageFacts(blocksJson) {
  if (!Array.isArray(blocksJson)) return [];
  const facts = [];
  for (const block of blocksJson) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "hero") {
      if (block.headline) facts.push(`Headline: ${truncate(block.headline, 240)}`);
      if (block.subheadline)
        facts.push(`Subheadline: ${truncate(block.subheadline, 240)}`);
    } else if (block.type === "key_details") {
      if (Array.isArray(block.items)) {
        for (const item of block.items) {
          if (item?.label && item?.value)
            facts.push(`${item.label}: ${truncate(String(item.value), 200)}`);
        }
      }
    } else if (block.type === "paragraph") {
      if (block.body) facts.push(`Body: ${truncate(block.body, 400)}`);
    } else if (block.type === "contact") {
      if (block.phone) facts.push(`Contact phone: ${block.phone}`);
      if (block.email) facts.push(`Contact email: ${block.email}`);
      if (block.address) facts.push(`Address: ${block.address}`);
    } else if (block.type === "cta") {
      if (block.label) facts.push(`Call to action: ${block.label}`);
    } else if (block.type === "faq") {
      if (Array.isArray(block.items)) {
        for (const item of block.items) {
          if (item?.question && item?.answer)
            facts.push(`FAQ — ${item.question} → ${truncate(item.answer, 240)}`);
        }
      }
    }
  }
  return facts;
}

// Pull whitelisted property/data fields from WorkspaceDataItem.dataJson.
// Real estate is the primary listing case; the generic branch below
// also surfaces any string/number/boolean field with a short value
// so non-property data items (offers, events, services) still get
// useful coverage.
const PROPERTY_FACT_FIELDS = [
  ["address", "Address"],
  ["street", "Street"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP"],
  ["price", "Price"],
  ["propertyType", "Property type"],
  ["bedrooms", "Bedrooms"],
  ["bathrooms", "Bathrooms"],
  ["sqft", "Sq ft"],
  ["lotSize", "Lot size"],
  ["yearBuilt", "Year built"],
  ["garage", "Garage"],
  ["mlsNumber", "MLS #"],
  ["status", "Listing status"],
  ["description", "Description"],
  ["highlights", "Highlights"],
  ["agentName", "Listing agent"],
  ["brokerage", "Brokerage"],
  ["listingUrl", "Listing URL"],
];

function collectDataItemFacts(dataJson) {
  if (!dataJson || typeof dataJson !== "object") return [];
  const facts = [];
  const seen = new Set();
  // Property/listing whitelist first — keeps the most useful facts
  // up top regardless of dataJson key order.
  for (const [key, label] of PROPERTY_FACT_FIELDS) {
    const v = dataJson[key];
    if (v === null || v === undefined || v === "") continue;
    const str = typeof v === "string" ? v.trim() : String(v);
    if (!str) continue;
    facts.push(`${label}: ${truncate(str, 400)}`);
    seen.add(key);
  }
  // Generic fallback for any other top-level fields the data item
  // happens to carry. Bounded to 8 extras so an unusually wide
  // dataJson doesn't blow up the prompt.
  let extras = 0;
  for (const [key, value] of Object.entries(dataJson)) {
    if (seen.has(key)) continue;
    if (extras >= 8) break;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue; // skip nested
    facts.push(`${humanizePromptKey(key)}: ${truncate(String(value), 240)}`);
    extras += 1;
  }
  return facts;
}

function collectSubmissionFacts(dataJson) {
  if (!dataJson || typeof dataJson !== "object") return [];
  const facts = [];
  for (const [key, value] of Object.entries(dataJson)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue;
    const str = String(value).trim();
    if (!str) continue;
    facts.push(`${humanizePromptKey(key)}: ${truncate(str, 400)}`);
  }
  return facts;
}

function humanizePromptKey(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
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
  const [unreadCount, openCount, spamCount, totalCount] = await Promise.all([
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
    // Spam bucket — independent of status so it stays accurate
    // even after a closed-then-marked-spam conversation.
    prisma.conversation.count({
      where: { clientId, spam: true },
    }),
    // Total conversations in the workspace, regardless of status
    // or spam. Powers the "Total" pill in the redesigned header.
    prisma.conversation.count({
      where: { clientId },
    }),
  ]);
  return { unreadCount, openCount, spamCount, totalCount };
}

// ── Contact mutation (CRM-lite) ─────────────────────────────────────────
//
// Workspace user edits to a Contact row: status, identity (name /
// email / phone), and tags. Tenant-scoped — every lookup filters by
// clientId so a forgotten route guard can't cross workspaces.
//
// Partial PATCH semantics: undefined keys stay untouched, null on
// nullable fields explicitly clears the value. The schema layer
// trims whitespace and turns blank strings into null.

const CONTACT_AUDITABLE_KEYS = ["status", "name", "email", "phone", "tags"];

/**
 * Apply a partial update to a Contact. Tenant-isolated by clientId.
 *
 * Errors thrown (each carries .status + .code):
 *   404 CONTACT_NOT_FOUND     — no contact with this id in this workspace
 *   400 IDENTITY_REQUIRED     — the change would leave the row with
 *                                no email AND no phone (we never allow
 *                                an identity-less contact)
 *   409 IDENTITY_CONFLICT     — another contact in this workspace
 *                                already uses the email or phone
 *
 * Returns the freshly-updated Contact row.
 */
export async function updateContact(clientId, contactId, patch) {
  const existing = await prisma.contact.findFirst({
    where: { id: contactId, clientId },
  });
  if (!existing) {
    const err = new Error("Contact not found");
    err.status = 404;
    err.code = "CONTACT_NOT_FOUND";
    throw err;
  }

  // Build the prospective new identity state so we can enforce the
  // "at least one of email/phone is non-null" rule without doing
  // two round-trips. undefined means "no change", null means "clear".
  const nextEmail = patch.email === undefined ? existing.email : patch.email;
  const nextPhone = patch.phone === undefined ? existing.phone : patch.phone;
  if (!nextEmail && !nextPhone) {
    const err = new Error("Contact must keep at least one of email or phone");
    err.status = 400;
    err.code = "IDENTITY_REQUIRED";
    throw err;
  }

  // Only include keys the caller actually provided. Letting
  // `undefined` through to Prisma is fine (it ignores them), but
  // building an explicit `data` keeps the audit diff legible.
  const data = {};
  for (const key of CONTACT_AUDITABLE_KEYS) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }

  let updated;
  try {
    updated = await prisma.contact.update({
      where: { id: existing.id },
      data,
    });
  } catch (e) {
    // Composite unique on (clientId, email) or (clientId, phone).
    // Surface a 409 so the UI can prompt the user to merge or pick
    // a different value — better than a bare 500.
    if (e?.code === "P2002") {
      const target = Array.isArray(e?.meta?.target) ? e.meta.target.join(",") : "";
      const field = target.includes("email")
        ? "email"
        : target.includes("phone")
          ? "phone"
          : "identity";
      const err = new Error(
        `Another contact in this workspace already has that ${field}.`,
      );
      err.status = 409;
      err.code = "IDENTITY_CONFLICT";
      err.field = field;
      throw err;
    }
    throw e;
  }

  // Audit diff: before / after for every key the caller touched.
  // Skips fields that didn't change (status set to its current value)
  // so the audit table doesn't fill with no-op rows.
  const diff = {};
  for (const key of CONTACT_AUDITABLE_KEYS) {
    if (patch[key] === undefined) continue;
    if (Array.isArray(existing[key]) || Array.isArray(updated[key])) {
      const a = JSON.stringify(existing[key] ?? []);
      const b = JSON.stringify(updated[key] ?? []);
      if (a !== b) diff[key] = { from: existing[key] ?? [], to: updated[key] ?? [] };
    } else if (existing[key] !== updated[key]) {
      diff[key] = { from: existing[key] ?? null, to: updated[key] ?? null };
    }
  }
  return { contact: updated, diff };
}
