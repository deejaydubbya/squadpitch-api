// Content Studio AI generation service.
//
// Model-agnostic, testable facade around the OpenAI provider. Routes call
// `generateDraft` — never the provider directly. Provider errors are
// captured as FAILED draft rows so operators see them in the queue.

import { prisma } from "../../../prisma.js";
import { loadClientGenerationContext } from "./clientOrchestrator.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildResponseFormat,
} from "./promptBuilder.js";
import {
  generateStructuredContent,
  OpenAIProviderError,
} from "./openai.provider.js";
import { formatDraft } from "../draft.service.js";

/**
 * Persist a FAILED draft row when generation fails so operators see the
 * error in the review queue. Mirrors the aiPersona generation.service.js
 * persistFailedDraft pattern.
 */
async function persistFailedDraft({
  clientId,
  kind,
  channel,
  bucketKey,
  guidance,
  createdBy,
  error,
}) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof OpenAIProviderError && error.code
      ? error.code
      : "GENERATION_FAILED";

  return prisma.draft.create({
    data: {
      clientId,
      kind,
      status: "FAILED",
      channel,
      bucketKey: bucketKey ?? null,
      generationGuidance: guidance ?? "",
      modelUsed: "openai-error",
      body: "",
      hooks: [],
      hashtags: [],
      cta: null,
      variations: null,
      altText: null,
      warnings: [`[${code}] ${message}`],
      createdBy,
    },
  });
}

/**
 * Normalize the structured response from OpenAI into the shape we persist.
 */
function normalizeGeneratedContent(parsed) {
  return {
    body: typeof parsed?.body === "string" ? parsed.body : "",
    hooks: Array.isArray(parsed?.hooks)
      ? parsed.hooks.filter((h) => typeof h === "string")
      : [],
    hashtags: Array.isArray(parsed?.hashtags)
      ? parsed.hashtags
          .filter((h) => typeof h === "string")
          .map((h) => h.replace(/^#+/, ""))
      : [],
    cta:
      typeof parsed?.cta === "string" && parsed.cta.length > 0
        ? parsed.cta
        : null,
    variations: Array.isArray(parsed?.variations)
      ? parsed.variations.filter((v) => typeof v === "string")
      : [],
    altText:
      typeof parsed?.altText === "string" && parsed.altText.length > 0
        ? parsed.altText
        : null,
    imageGuidance:
      typeof parsed?.imageGuidance === "string" && parsed.imageGuidance.length > 0
        ? parsed.imageGuidance
        : null,
  };
}

/**
 * Generate a Content Studio draft.
 *
 * On generation errors this returns a FAILED draft (never throws to the
 * caller for provider-side issues). Caller errors (e.g. missing client)
 * are still surfaced as structured errors from the orchestrator.
 */
export async function generateDraft({
  clientId,
  kind,
  channel,
  bucketKey,
  guidance,
  createdBy,
}) {
  const ctx = await loadClientGenerationContext(clientId);

  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = buildUserPrompt(ctx, {
    kind,
    channel,
    bucketKey,
    guidance,
  });
  const responseFormat = buildResponseFormat();

  let result;
  try {
    result = await generateStructuredContent({
      systemPrompt,
      userPrompt,
      responseFormat,
      temperature: 0.7,
    });
  } catch (err) {
    const failed = await persistFailedDraft({
      clientId,
      kind,
      channel,
      bucketKey,
      guidance,
      createdBy,
      error: err,
    });
    return formatDraft(failed);
  }

  const content = normalizeGeneratedContent(result.parsed);

  const promptVersion = ctx.voice?.version ?? 1;

  const draft = await prisma.draft.create({
    data: {
      clientId,
      kind,
      status: "DRAFT",
      channel,
      bucketKey: bucketKey ?? null,
      generationGuidance: guidance ?? "",
      modelUsed: result.model,
      promptVersion,
      body: content.body,
      hooks: content.hooks,
      hashtags: content.hashtags,
      cta: content.cta,
      variations: content.variations.length > 0 ? content.variations : null,
      altText: content.altText,
      imageGuidance: content.imageGuidance,
      warnings: [],
      createdBy,
    },
  });

  return formatDraft(draft);
}
