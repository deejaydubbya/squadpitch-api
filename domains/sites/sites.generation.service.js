// SquadSites page generation service.
//
// Takes a workspace + source descriptor (campaign / property /
// data_item / idea) + a page goal, and asks OpenAI to draft a
// full SitePage payload — title, slug, description, SEO meta,
// blocks array, and a suggested lead-form field list. The
// response is normalized to the shapes the dashboard expects so
// the page can be persisted as a DRAFT immediately.
//
// Generation is best-effort. If the LLM call fails or returns
// malformed JSON we surface a typed error (status + code) so the
// route can either:
//   (a) return 503 SERVICE_UNAVAILABLE on infrastructure issues
//   (b) return a structured error code to the dashboard so the
//       UI can prompt the user to retry or fall back to a manual
//       template
// We don't persist failed attempts as DRAFT rows the way the
// Studio content generator does — page generation is interactive,
// the user will see the failure inline and try again.

import { prisma } from "../../prisma.js";
import { loadClientGenerationContext } from "../studio/generation/clientOrchestrator.js";
import {
  generateStructuredContent,
  OpenAIProviderError,
} from "../studio/generation/openai.provider.js";
import { trackAiUsage } from "../billing/aiUsageTracking.service.js";

// JSON schema passed to OpenAI's structured-output endpoint as a
// shape hint. Block enums here mirror the runtime block
// renderers — adding a new block type means updating both the
// runtime + this schema.
//
// IMPORTANT: this schema is intentionally NOT strict-mode
// (`strict: false` on the response_format below). The block
// items array can contain either key_details rows ({label, value})
// or faq rows ({question, answer}), so the inner row object
// can't legitimately require all four keys. Strict mode insists
// every property be in `required`, which would force the model
// to fabricate placeholder values for the wrong block type.
// Non-strict mode lets OpenAI use the schema as guidance; the
// post-parse normalizer (normalizeBlock) is the real validator
// and drops any block that doesn't have its required fields.
const PAGE_OUTPUT_SCHEMA = {
  name: "site_page",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      slug: { type: "string", minLength: 1, maxLength: 128 },
      description: { type: "string", maxLength: 400 },
      seoTitle: { type: "string", maxLength: 160 },
      seoDescription: { type: "string", maxLength: 400 },
      blocks: {
        type: "array",
        minItems: 3,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "hero",
                "paragraph",
                "image",
                "cta",
                "lead_form",
                "key_details",
                "testimonial",
                "faq",
                "contact",
              ],
            },
            // All block-field properties are optional at the
            // schema layer — we filter and normalize per block
            // type after parse so unknown fields don't poison
            // the runtime renderer. The LLM picks the subset
            // that's relevant per block type (hero uses
            // headline + subheadline, faq uses items, etc.)
            headline: { type: "string" },
            subheadline: { type: "string" },
            body: { type: "string" },
            label: { type: "string" },
            href: { type: "string" },
            imageUrl: { type: "string" },
            alt: { type: "string" },
            caption: { type: "string" },
            heading: { type: "string" },
            quote: { type: "string" },
            author: { type: "string" },
            role: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
            address: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                  question: { type: "string" },
                  answer: { type: "string" },
                },
                additionalProperties: false,
              },
            },
            includeLeadForm: { type: "boolean" },
          },
          required: ["type"],
          additionalProperties: false,
        },
      },
      suggestedFormFields: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            key: { type: "string", maxLength: 40 },
            label: { type: "string", maxLength: 120 },
            type: {
              type: "string",
              enum: ["text", "email", "phone", "textarea", "select", "checkbox"],
            },
            required: { type: "boolean" },
          },
          required: ["key", "label", "type"],
          additionalProperties: false,
        },
      },
      formSuccessMessage: { type: "string", maxLength: 400 },
    },
    required: ["title", "slug", "description", "blocks", "suggestedFormFields"],
    additionalProperties: false,
  },
  strict: false,
};

const PAGE_GOAL_BLURB = {
  LEAD_CAPTURE: "capture qualified leads via an inline contact form",
  LISTING: "promote a single property/listing and drive showing requests",
  OFFER: "convert visitors on a time-limited offer or promotion",
  EVENT: "drive RSVPs and registrations for an event or open house",
  CONSULTATION: "book consultations with the agent/business",
};

// ── Public service API ─────────────────────────────────────────────────

/**
 * Generate a SitePage payload from a workspace source.
 *
 * Inputs:
 *   - clientId  — the workspace
 *   - sourceType (CAMPAIGN | PROPERTY | DATA_ITEM | IDEA)
 *   - sourceId  — required for non-IDEA sources
 *   - pageGoal  — one of the SitePageGoal enum values
 *   - customPrompt? — free-form context the user pasted in
 *
 * Returns:
 *   {
 *     payload: { title, slug, description, seoTitle, seoDescription, blocksJson },
 *     suggestedFormFields, formSuccessMessage,
 *     sourceContext: { sourceType, sourceId, title } — for attribution
 *     model, usage
 *   }
 *
 * Throws structured errors with .status + .code so route can
 * surface them cleanly:
 *   SOURCE_NOT_FOUND (404)
 *   INVALID_REQUEST (400)
 *   OPENAI_* (forwarded from the provider)
 */
export async function generatePageFromSource({
  clientId,
  sourceType,
  sourceId,
  pageGoal,
  customPrompt,
  userId,
}) {
  // 1. Load workspace context (brand + voice + persona + media).
  const ctx = await loadClientGenerationContext(clientId);

  // 2. Resolve the source data into a normalized blob the prompt
  //    builder can read. IDEA sources skip the DB read.
  const source = await resolveSource({ clientId, sourceType, sourceId, customPrompt });
  if (!source) {
    const err = new Error("Source not found in this workspace");
    err.status = 404;
    err.code = "SOURCE_NOT_FOUND";
    throw err;
  }

  // 3. Build prompts. System prompt sets persona + output rules.
  //    User prompt provides the brief.
  const systemPrompt = buildSystemPrompt({ ctx, pageGoal });
  const userPrompt = buildUserPrompt({ ctx, source, pageGoal, customPrompt });

  // 4. Call OpenAI with the JSON-schema-strict response format.
  const result = await generateStructuredContent({
    systemPrompt,
    userPrompt,
    taskType: "campaign_generation", // similar weight class
    responseFormat: { type: "json_schema", json_schema: PAGE_OUTPUT_SCHEMA },
    temperature: 0.7,
    timeoutMs: 45_000,
  });

  // 5. Fire-and-forget usage logging so we have cost telemetry.
  // trackAiUsage is sync (it handles its own .catch internally),
  // so don't chain a .catch here — that would crash on undefined.
  // actionType must be an AiActionType enum value; until we add
  // GENERATE_SITE_PAGE to the enum we lump under GENERATE_POST
  // — the sourceType + pageGoal in metadata disambiguates.
  trackAiUsage({
    userId,
    clientId,
    actionType: "GENERATE_POST",
    model: result.model,
    promptTokens: result.usage?.prompt_tokens ?? 0,
    completionTokens: result.usage?.completion_tokens ?? 0,
    metadata: { source: "site_page", sourceType, pageGoal },
  });

  // 6. Normalize the LLM output. The strict response_format makes
  //    this mostly defensive — but we still trim slugs, drop
  //    invalid blocks, and fill missing defaults.
  return normalizeGeneratedPage({
    raw: result.parsed,
    sourceType,
    sourceId: source.id ?? sourceId,
    sourceTitle: source.title,
    pageGoal,
    model: result.model,
    usage: result.usage,
  });
}

// ── Source resolution ──────────────────────────────────────────────────

async function resolveSource({ clientId, sourceType, sourceId, customPrompt }) {
  if (sourceType === "IDEA") {
    // Idea is freeform — the customPrompt IS the source.
    if (!customPrompt || typeof customPrompt !== "string" || !customPrompt.trim()) {
      const err = new Error(
        "IDEA source requires a non-empty customPrompt with the page brief",
      );
      err.status = 400;
      err.code = "MISSING_PROMPT";
      throw err;
    }
    return {
      kind: "idea",
      id: null,
      title: customPrompt.trim().slice(0, 80),
      brief: customPrompt.trim(),
    };
  }

  if (typeof sourceId !== "string" || !sourceId) {
    const err = new Error(`${sourceType} source requires a sourceId`);
    err.status = 400;
    err.code = "MISSING_SOURCE_ID";
    throw err;
  }

  if (sourceType === "CAMPAIGN") {
    const campaign = await prisma.campaign.findFirst({
      where: { id: sourceId, clientId },
      select: {
        id: true,
        name: true,
        campaignType: true,
        campaignIdea: true,
        sourceTitle: true,
        sourceDataItemId: true,
      },
    });
    if (!campaign) return null;
    return {
      kind: "campaign",
      id: campaign.id,
      title: campaign.name,
      brief: [
        campaign.campaignIdea,
        campaign.sourceTitle && `Source: ${campaign.sourceTitle}`,
        campaign.campaignType && `Type: ${campaign.campaignType}`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (sourceType === "PROPERTY" || sourceType === "DATA_ITEM") {
    const item = await prisma.workspaceDataItem.findFirst({
      where: { id: sourceId, clientId },
      select: {
        id: true,
        title: true,
        summary: true,
        dataJson: true,
        type: true,
        tags: true,
      },
    });
    if (!item) return null;
    return {
      kind: sourceType === "PROPERTY" ? "property" : "data_item",
      id: item.id,
      title: item.title,
      summary: item.summary,
      dataJson: item.dataJson,
      tags: item.tags ?? [],
      brief: [
        item.summary,
        // Stringify dataJson at a sensible cap so the prompt
        // stays inside token budget on absurdly large rows.
        item.dataJson && safeJsonPreview(item.dataJson, 2000),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  const err = new Error(`Unknown sourceType: ${sourceType}`);
  err.status = 400;
  err.code = "INVALID_SOURCE_TYPE";
  throw err;
}

// ── Prompt assembly ────────────────────────────────────────────────────

function buildSystemPrompt({ ctx, pageGoal }) {
  const brandName = ctx.client?.name ?? "the business";
  const industryName = ctx.client?.industryKey ?? null;
  const voice = ctx.voice ?? null;
  const brand = ctx.brand ?? null;

  const voiceLines = [];
  if (voice?.tone) voiceLines.push(`Tone: ${voice.tone}`);
  if (voice?.style) voiceLines.push(`Style: ${voice.style}`);
  if (voice?.persona) voiceLines.push(`Persona: ${voice.persona}`);
  if (Array.isArray(voice?.commonPhrases) && voice.commonPhrases.length > 0) {
    voiceLines.push(`Common phrases: ${voice.commonPhrases.slice(0, 5).join("; ")}`);
  }

  const brandLines = [];
  if (brand?.tagline) brandLines.push(`Tagline: ${brand.tagline}`);
  if (brand?.valueProposition)
    brandLines.push(`Value proposition: ${brand.valueProposition}`);
  if (Array.isArray(brand?.targetAudience) && brand.targetAudience.length > 0) {
    brandLines.push(`Target audience: ${brand.targetAudience.join(", ")}`);
  }

  const goalBlurb = PAGE_GOAL_BLURB[pageGoal] || "convert visitors";

  return [
    `You write conversion-focused landing-page copy for ${brandName}${industryName ? ` (industry: ${industryName})` : ""}.`,
    `The page's goal is to ${goalBlurb}.`,
    "",
    brandLines.length > 0 ? `Brand context:\n${brandLines.join("\n")}` : "",
    voiceLines.length > 0 ? `\nVoice profile:\n${voiceLines.join("\n")}` : "",
    "",
    "Output rules:",
    "- Respond ONLY with JSON matching the supplied schema.",
    "- Block sequence should flow: hero first, then body content,",
    "  ending with a CTA and (if appropriate) a lead_form block.",
    "- The lead_form block carries no fields itself — write the",
    "  fields into suggestedFormFields. Always include 'name' + 'email'",
    "  fields at minimum if you include a lead_form block.",
    "- Slug: lowercase, dash-separated, no spaces, max 60 chars,",
    "  derived from the page topic (NOT the brand name).",
    "- Use second-person ('you') in body copy when natural.",
    "- Don't fabricate facts about specific properties / data the",
    "  brief doesn't mention. Stick to the supplied context.",
    "- CTA href: leave as '#contact' if no specific URL is supplied —",
    "  the workspace owner will replace it.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUserPrompt({ source, pageGoal, customPrompt }) {
  const lines = [
    `# Page brief`,
    ``,
    `**Source type:** ${source.kind}`,
    `**Source title:** ${source.title}`,
    `**Page goal:** ${pageGoal}`,
    ``,
    `## Context`,
    source.brief || "(no additional context)",
  ];
  if (customPrompt && source.kind !== "idea") {
    lines.push("", `## Additional notes from the user`, customPrompt);
  }
  lines.push(
    "",
    "Generate a JSON page payload per the schema. The page should",
    "be self-contained — a visitor arriving cold should understand",
    "what's on offer and how to act on it within 5 seconds of",
    "scrolling.",
  );
  return lines.join("\n");
}

// ── Normalization ──────────────────────────────────────────────────────

function normalizeGeneratedPage({
  raw,
  sourceType,
  sourceId,
  sourceTitle,
  pageGoal,
  model,
  usage,
}) {
  const rawBlocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
  const blocksJson = [];
  let sawLeadFormBlock = false;

  for (const block of rawBlocks) {
    const normalized = normalizeBlock(block);
    if (!normalized) continue;
    blocksJson.push(normalized);
    if (normalized.type === "lead_form") sawLeadFormBlock = true;
  }

  // Defensive: every goal except LISTING really wants a lead_form
  // block. If the model forgot to include one, append a placeholder
  // that the route will wire to the auto-created LeadForm.
  if (!sawLeadFormBlock && pageGoal !== "LISTING") {
    blocksJson.push({ type: "lead_form", formId: "__PENDING__" });
  }

  const slug = sanitizeSlug(raw?.slug, sourceTitle);

  const suggestedFormFields = Array.isArray(raw?.suggestedFormFields)
    ? raw.suggestedFormFields
        .map(normalizeFormField)
        .filter(Boolean)
    : [];
  // Always ensure name + email are present at minimum.
  ensureMinimumFields(suggestedFormFields);

  return {
    payload: {
      title: trimString(raw?.title, 200) || `Untitled (${pageGoal.toLowerCase()})`,
      slug,
      description: trimString(raw?.description, 400) || null,
      seoTitle: trimString(raw?.seoTitle, 160) || null,
      seoDescription: trimString(raw?.seoDescription, 400) || null,
      blocksJson,
    },
    suggestedFormFields,
    formSuccessMessage:
      trimString(raw?.formSuccessMessage, 400) ||
      "Thanks — we'll be in touch shortly.",
    sourceContext: { sourceType, sourceId, title: sourceTitle },
    model,
    usage,
  };
}

function normalizeBlock(block) {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "hero":
      return {
        type: "hero",
        headline: trimString(block.headline, 240) || "",
        subheadline: trimString(block.subheadline, 600) || "",
        ...(block.imageUrl && isSafeUrl(block.imageUrl) ? { imageUrl: block.imageUrl } : {}),
      };
    case "paragraph": {
      const body = trimString(block.body, 4000);
      if (!body) return null;
      return { type: "paragraph", body };
    }
    case "image":
      if (!block.imageUrl || !isSafeUrl(block.imageUrl)) return null;
      return {
        type: "image",
        imageUrl: block.imageUrl,
        alt: trimString(block.alt, 240) || "",
        caption: trimString(block.caption, 400) || "",
      };
    case "cta": {
      const label = trimString(block.label, 120);
      if (!label) return null;
      const href = isSafeUrl(block.href) ? block.href : "#contact";
      return { type: "cta", label, href };
    }
    case "lead_form":
      // The route fills in the real formId before persisting.
      return { type: "lead_form", formId: "__PENDING__" };
    case "key_details": {
      const items = Array.isArray(block.items)
        ? block.items
            .map((it) => {
              if (!it || typeof it !== "object") return null;
              const label = trimString(it.label, 80);
              const value = trimString(it.value, 240);
              if (!label || !value) return null;
              return { label, value };
            })
            .filter(Boolean)
        : [];
      if (items.length === 0) return null;
      return {
        type: "key_details",
        ...(trimString(block.heading, 120) ? { heading: trimString(block.heading, 120) } : {}),
        items,
      };
    }
    case "testimonial": {
      const quote = trimString(block.quote, 800);
      if (!quote) return null;
      return {
        type: "testimonial",
        quote,
        ...(trimString(block.author, 120) ? { author: trimString(block.author, 120) } : {}),
        ...(trimString(block.role, 120) ? { role: trimString(block.role, 120) } : {}),
        ...(block.imageUrl && isSafeUrl(block.imageUrl) ? { imageUrl: block.imageUrl } : {}),
      };
    }
    case "faq": {
      const items = Array.isArray(block.items)
        ? block.items
            .map((it) => {
              if (!it || typeof it !== "object") return null;
              const question = trimString(it.question, 240);
              const answer = trimString(it.answer, 2000);
              if (!question || !answer) return null;
              return { question, answer };
            })
            .filter(Boolean)
        : [];
      if (items.length === 0) return null;
      return {
        type: "faq",
        ...(trimString(block.heading, 120) ? { heading: trimString(block.heading, 120) } : {}),
        items,
      };
    }
    case "contact": {
      const phone = trimString(block.phone, 40);
      const email = trimString(block.email, 200);
      const address = trimString(block.address, 400);
      if (!phone && !email && !address) return null;
      return {
        type: "contact",
        ...(trimString(block.heading, 120) ? { heading: trimString(block.heading, 120) } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(address ? { address } : {}),
      };
    }
    default:
      return null;
  }
}

function normalizeFormField(field) {
  if (!field || typeof field !== "object") return null;
  const key = sanitizeFieldKey(field.key);
  const label = trimString(field.label, 120);
  const type = field.type;
  if (!key || !label) return null;
  if (
    type !== "text" &&
    type !== "email" &&
    type !== "phone" &&
    type !== "textarea" &&
    type !== "select" &&
    type !== "checkbox"
  ) {
    return null;
  }
  return {
    key,
    label,
    type,
    required: field.required === true,
  };
}

function ensureMinimumFields(fields) {
  const keys = new Set(fields.map((f) => f.key));
  if (!keys.has("name")) {
    fields.unshift({
      key: "name",
      label: "Your name",
      type: "text",
      required: true,
    });
  }
  if (!keys.has("email") && !keys.has("phone")) {
    fields.splice(1, 0, {
      key: "email",
      label: "Email",
      type: "email",
      required: true,
    });
  }
}

// ── Tiny helpers ───────────────────────────────────────────────────────

function trimString(s, max) {
  if (typeof s !== "string") return "";
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function sanitizeSlug(raw, fallback) {
  const seed = typeof raw === "string" && raw.trim() ? raw : fallback ?? "page";
  const slug = String(seed)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "page";
}

function sanitizeFieldKey(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!cleaned) return null;
  // Field key regex from sites.schemas.js requires a leading letter.
  if (!/^[a-z]/.test(cleaned)) return `f_${cleaned}`.slice(0, 40);
  return cleaned;
}

function isSafeUrl(url) {
  if (typeof url !== "string") return false;
  return /^https?:\/\//i.test(url);
}

function safeJsonPreview(value, maxChars) {
  try {
    const json = JSON.stringify(value, null, 0);
    if (json.length <= maxChars) return json;
    return `${json.slice(0, maxChars)}…[truncated]`;
  } catch {
    return null;
  }
}
