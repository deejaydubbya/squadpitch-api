// Inline AI Action execution service.
//
// Each action type maps to a guidance template injected into the standard
// generation pipeline. Schedule optimization is pure computation (no AI).

import { prisma } from "../../prisma.js";
import { loadClientGenerationContext } from "./generation/clientOrchestrator.js";
import { buildSystemPrompt, buildResponseFormat } from "./generation/promptBuilder.js";
import { generateStructuredContent } from "./generation/openai.provider.js";
import {
  getBestTimeForChannel,
  CHANNEL_BEST_DAYS,
} from "./postTiming.js";

// ── Action Guidance Templates ────────────────────────────────────────────

const ACTION_GUIDANCE = {
  rewrite_post: (draft, params) =>
    `Rewrite this post with a fresh perspective${params.focus ? `, focusing on ${params.focus}` : ""}. Keep the same core message but change structure, word choice, and hook.\n\nOriginal:\n"""${draft.body}"""`,

  generate_variations: (draft) =>
    `Create 3 completely different variations of this post. Each takes a different angle while keeping the same message.\n\nOriginal:\n"""${draft.body}"""`,

  improve_caption: (draft) =>
    `Improve this post — polish grammar, strengthen the hook, improve flow. Do NOT change the core message.\n\nOriginal:\n"""${draft.body}"""`,

  adjust_tone: (draft, params) =>
    `Rewrite this post in a ${params.tone || "professional"} tone. Keep the same message.\n\nOriginal:\n"""${draft.body}"""`,

  expand_post: (draft) =>
    `Expand this post with more detail and storytelling. Make it 50-80% longer while keeping it engaging.\n\nOriginal:\n"""${draft.body}"""`,
};

// ── Schedule Optimization (pure computation) ─────────────────────────────

function computeOptimalSchedule(draft) {
  const best = getBestTimeForChannel(draft.channel);
  const bestDays = CHANNEL_BEST_DAYS[draft.channel] ?? [1, 2, 3, 4, 5];

  const now = new Date();
  const candidate = new Date(now);

  // Find next optimal day/hour from now
  for (let offset = 0; offset < 14; offset++) {
    candidate.setTime(now.getTime() + offset * 24 * 60 * 60 * 1000);
    candidate.setHours(best.hour, 0, 0, 0);

    if (candidate <= now) continue;
    if (!bestDays.includes(candidate.getDay())) continue;

    const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][candidate.getDay()];
    return {
      scheduledFor: candidate.toISOString(),
      reason: `${dayName} at ${best.hour}:00 (${best.label}) — highest engagement window for ${draft.channel}`,
    };
  }

  // Fallback: next best-day at best hour
  candidate.setTime(now.getTime() + 24 * 60 * 60 * 1000);
  candidate.setHours(best.hour, 0, 0, 0);
  return {
    scheduledFor: candidate.toISOString(),
    reason: `${best.label} — best available time for ${draft.channel}`,
  };
}

// ── Main Executor ────────────────────────────────────────────────────────

/**
 * Execute an inline action on a draft.
 *
 * @param {object} opts
 * @param {string} opts.draftId
 * @param {string} opts.actionType
 * @param {Record<string, string>} opts.params
 * @param {string} opts.userId
 * @returns {Promise<object>} InlineActionResult
 */
export async function executeInlineAction({ draftId, actionType, params, userId }) {
  const draft = await prisma.draft.findUnique({ where: { id: draftId } });
  if (!draft) {
    const err = new Error("Draft not found");
    err.status = 404;
    throw err;
  }

  // ── Schedule optimization — no AI call ──
  if (actionType === "optimize_schedule") {
    const suggestedSchedule = computeOptimalSchedule(draft);
    return {
      actionType,
      outputMode: "preview",
      suggestedSchedule,
    };
  }

  // ── AI-powered actions ──
  const guidanceFn = ACTION_GUIDANCE[actionType];
  if (!guidanceFn) {
    const err = new Error(`Unknown action type: ${actionType}`);
    err.status = 400;
    throw err;
  }

  const ctx = await loadClientGenerationContext(draft.clientId);
  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = guidanceFn(draft, params);
  const responseFormat = buildResponseFormat();

  const { parsed, model } = await generateStructuredContent({
    systemPrompt,
    userPrompt,
    responseFormat,
    taskType: "inline_action",
  });

  // ── Generate Variations — create new draft rows ──
  if (actionType === "generate_variations") {
    const variations = parsed.variations ?? [];
    const sources = [
      { body: parsed.body, hooks: parsed.hooks, hashtags: parsed.hashtags, cta: parsed.cta },
      ...variations,
    ].slice(0, 3);

    const newDraftIds = [];
    for (const v of sources) {
      const newDraft = await prisma.draft.create({
        data: {
          clientId: draft.clientId,
          kind: draft.kind,
          status: "DRAFT",
          channel: draft.channel,
          bucketKey: draft.bucketKey,
          generationGuidance: draft.generationGuidance,
          modelUsed: model,
          body: v.body,
          hooks: v.hooks ?? [],
          hashtags: v.hashtags ?? [],
          cta: v.cta || null,
          variations: null,
          altText: null,
          warnings: ["source:inline_variation", `parent:${draftId}`],
          createdBy: userId,
        },
      });
      newDraftIds.push(newDraft.id);
    }

    return {
      actionType,
      outputMode: "duplicate",
      newDraftIds,
    };
  }

  // ── Replace actions — return preview ──
  return {
    actionType,
    outputMode: "replace",
    preview: {
      body: parsed.body,
      hooks: parsed.hooks ?? [],
      hashtags: parsed.hashtags ?? [],
      cta: parsed.cta || null,
    },
  };
}
