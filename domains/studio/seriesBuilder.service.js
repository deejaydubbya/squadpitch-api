// Series Builder Service.
//
// Generates multi-part content series (e.g. "Day 1: Tip #1", "Day 2: Tip #2").
// Reuses existing campaign fields (campaignId, campaignDay, campaignOrder, campaignTotal)
// for series tracking. Each part is an independent draft linked by campaignId.
//
// Two exports:
//   generateSeries — create a full N-part series
//   SERIES_TEMPLATES — predefined series structures

import crypto from "crypto";
import { prisma } from "../../prisma.js";
import { generateDraft } from "./generation/aiGenerationService.js";
import { formatDraft } from "./draft.service.js";

// ── Series Templates ────────────────────────────────────────────────────

export const SERIES_TEMPLATES = [
  {
    id: "tips_series",
    name: "Tips Series",
    description: "Multi-day tips series — each post shares one actionable tip",
    defaultParts: 3,
    maxParts: 7,
    guidanceTemplate: (topic, partNum, totalParts) =>
      `[Series: Part ${partNum} of ${totalParts}] Create tip #${partNum} about "${topic}". Make it specific, actionable, and self-contained. Reference that this is part of a series — e.g. "Tip ${partNum}/${totalParts}".`,
  },
  {
    id: "myth_busters",
    name: "Myth Busters",
    description: "Bust common myths one per day — contrarian, educational",
    defaultParts: 3,
    maxParts: 5,
    guidanceTemplate: (topic, partNum, totalParts) =>
      `[Series: Part ${partNum} of ${totalParts}] [Type: growth] Bust myth #${partNum} about "${topic}". Start with the common misconception, then reveal the truth with evidence or experience. Make it shareable and save-worthy.`,
  },
  {
    id: "neighborhood_spotlight",
    name: "Neighborhood Spotlight",
    description: "Explore a different neighborhood each day — lifestyle-focused",
    defaultParts: 3,
    maxParts: 5,
    guidanceTemplate: (topic, partNum, totalParts) =>
      `[Series: Part ${partNum} of ${totalParts}] Spotlight a different aspect or neighborhood related to "${topic}". Focus on lifestyle, local gems, and community feel. Make viewers want to explore.`,
  },
  {
    id: "buyer_guide",
    name: "Buyer's Guide",
    description: "Step-by-step home buying guide — educational series",
    defaultParts: 5,
    maxParts: 7,
    guidanceTemplate: (topic, partNum, totalParts) =>
      `[Series: Part ${partNum} of ${totalParts}] Cover step ${partNum} of the home buying process related to "${topic}". Be practical and specific. Each part should teach one clear lesson that builds on the series.`,
  },
  {
    id: "before_after",
    name: "Before & After",
    description: "Transformation series — renovations, staging, market changes",
    defaultParts: 3,
    maxParts: 5,
    guidanceTemplate: (topic, partNum, totalParts) =>
      `[Series: Part ${partNum} of ${totalParts}] Show transformation #${partNum} related to "${topic}". Build the before → after narrative with specific details. Create anticipation for the next part.`,
  },
  {
    id: "custom",
    name: "Custom Series",
    description: "Create your own series structure",
    defaultParts: 3,
    maxParts: 7,
    guidanceTemplate: (topic, partNum, totalParts) =>
      `[Series: Part ${partNum} of ${totalParts}] Create part ${partNum} of a series about "${topic}". Make each part distinct but connected. Reference the series structure.`,
  },
];

// ── generateSeries ──────────────────────────────────────────────────────

/**
 * Generate a full content series.
 *
 * @param {string} clientId
 * @param {string} createdBy
 * @param {object} opts
 * @param {string} opts.topic         — the series topic
 * @param {string} opts.templateId    — series template ID
 * @param {number} opts.parts         — number of parts
 * @param {string} opts.channel       — target channel
 * @param {string} [opts.kind]        — draft kind (default POST)
 * @param {string} [opts.userId]      — for usage tracking
 * @returns {Promise<{ seriesId: string, seriesName: string, drafts: object[] }>}
 */
export async function generateSeries(
  clientId,
  createdBy,
  { topic, templateId, parts, channel, kind = "POST", userId }
) {
  const template = SERIES_TEMPLATES.find((t) => t.id === templateId) ?? SERIES_TEMPLATES.at(-1);
  const partCount = Math.min(Math.max(parts || template.defaultParts, 2), template.maxParts);

  const seriesId = `series_${crypto.randomUUID().slice(0, 8)}`;
  const seriesName = `${template.name}: ${topic}`;

  const drafts = [];

  for (let i = 1; i <= partCount; i++) {
    const partGuidance = template.guidanceTemplate(topic, i, partCount);

    const draft = await generateDraft({
      clientId,
      kind,
      channel,
      guidance: partGuidance,
      templateType: templateId === "myth_busters" ? "growth" : null,
      createdBy,
      userId,
    });

    // Tag the draft with series (campaign) metadata
    if (draft?.id) {
      const updated = await prisma.draft.update({
        where: { id: draft.id },
        data: {
          campaignId: seriesId,
          campaignName: seriesName,
          campaignType: "series",
          campaignDay: i,
          campaignOrder: i,
          campaignTotal: partCount,
        },
      });
      drafts.push(formatDraft(updated));
    } else {
      drafts.push(draft); // Failed draft — still include
    }
  }

  return {
    seriesId,
    seriesName,
    totalParts: partCount,
    drafts,
  };
}
