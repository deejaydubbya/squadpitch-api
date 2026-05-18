// SquadPitch Autopilot — Campaign Recommendation persistence.
//
// Phase 2 of docs/AUTOPILOT_PRODUCT_AUDIT.md.
//
// This file owns the lifecycle of `AutopilotCampaignRecommendation`
// rows: list / stats / idempotent upsert / dismiss / expire-sweep.
// Detection logic lives in `autopilot.service.js`; this module
// just stores what the detector hands us and serves it back to
// the Campaign Inbox UI.
//
// What's deliberately NOT here:
//   - Trigger detection — that's the evaluator's job.
//   - Draft generation — Phase 3 wires `generateDraftsForRecommendation`.
//   - Approval / schedule — Phase 4.
//
// The unique constraint `(clientId, triggerType, triggerObjectId)`
// on the table enforces idempotency at the DB layer; the
// upsertRecommendation helper below catches a unique-violation race
// and falls back to update.

import { prisma } from "../../prisma.js";
import { writeAudit } from "../../lib/auditLog.js";

// ── BE → FE status / trigger serialization ─────────────────────────────
//
// The web-side type `AutopilotCampaignStatus` predates the Prisma
// enum; map the storage representation to what the existing UI
// renders so Phase 2 doesn't require a UI rewrite. SCHEDULED
// folds into 'approved' since the FE currently has no separate
// scheduled state on this surface.
const STATUS_BE_TO_FE = {
  NEEDS_REVIEW: "pending",
  DRAFT_GENERATED: "ready",
  APPROVED: "approved",
  SCHEDULED: "approved",
  DISMISSED: "dismissed",
  EXPIRED: "expired",
};

// FE's union for triggerType is listing-centric. Non-listing
// triggers (NEW_REVIEW, INACTIVITY_GAP, etc.) ship the BE name
// lowercased so a future FE expansion can branch on them without
// a server change.
function triggerToFe(t) {
  if (t === "OPEN_HOUSE") return "open_house_added";
  if (t === "JUST_SOLD") return "status_changed";
  return String(t).toLowerCase();
}

// Map an idempotency-friendly key for triggers that don't have a
// natural triggerObjectId (currently only INACTIVITY_GAP). We
// stamp a stable string so the unique constraint catches repeats
// within the same workspace.
function fallbackObjectId(triggerType) {
  return `__workspace_${String(triggerType).toLowerCase()}__`;
}

/**
 * Idempotently upsert a recommendation.
 *
 * Two-step (find → update OR create) instead of prisma.upsert
 * because we want to PRESERVE user-set fields (`status`,
 * `dismissedReason`, `decidedBy`) when the detector re-fires.
 * If a user dismissed a recommendation and the underlying
 * opportunity still exists on the next tick, we don't re-open it
 * — we just touch `updatedAt` + `expiresAt` so the row stays
 * "current" without overriding the user's choice.
 *
 * @param {object} input — minimum: clientId, triggerType,
 *   triggerObjectId (or null), headline, whatWeNoticed,
 *   whyItMatters, recommendedChannels, recommendedAngles.
 *   Optional: expiresAt, payloadJson, triggerObjectType.
 * @returns {Promise<{ status: 'created' | 'updated' | 'noop',
 *                     recommendationId: string }>}
 */
export async function upsertRecommendation(input) {
  const {
    clientId,
    triggerType,
    triggerObjectId = null,
    triggerObjectType = null,
    headline,
    whatWeNoticed,
    whyItMatters,
    recommendedChannels = [],
    recommendedAngles = [],
    expiresAt = null,
    payloadJson = null,
  } = input ?? {};

  if (!clientId || !triggerType || !headline) {
    throw Object.assign(new Error("clientId + triggerType + headline are required"), {
      status: 400,
      code: "BAD_RECOMMENDATION_INPUT",
    });
  }

  // Normalize the object id — null is fine for triggers that
  // don't reference a specific business object, but we still need
  // a stable key so the unique constraint catches duplicates
  // within the same workspace.
  const effectiveObjectId = triggerObjectId ?? fallbackObjectId(triggerType);

  const existing = await prisma.autopilotCampaignRecommendation.findFirst({
    where: { clientId, triggerType, triggerObjectId: effectiveObjectId },
    select: {
      id: true,
      status: true,
      dismissedReason: true,
      headline: true,
      whatWeNoticed: true,
      whyItMatters: true,
      recommendedChannels: true,
      recommendedAngles: true,
      payloadJson: true,
      expiresAt: true,
    },
  });

  if (existing) {
    // User-decided rows are sticky. We refresh expiresAt so the
    // expire-sweep doesn't snap them away mid-decision, but we
    // don't reset the status or wipe the user's reason.
    if (
      existing.status === "DISMISSED" ||
      existing.status === "APPROVED" ||
      existing.status === "SCHEDULED" ||
      existing.status === "DRAFT_GENERATED"
    ) {
      await prisma.autopilotCampaignRecommendation
        .update({
          where: { id: existing.id },
          data: { expiresAt },
        })
        .catch(() => {});
      return { status: "noop", recommendationId: existing.id };
    }
    // Open/NEEDS_REVIEW row — refresh the surface copy + the
    // payload (the detector may have updated facts).
    await prisma.autopilotCampaignRecommendation.update({
      where: { id: existing.id },
      data: {
        headline,
        whatWeNoticed,
        whyItMatters,
        recommendedChannels,
        recommendedAngles,
        payloadJson,
        expiresAt,
        triggerObjectType: triggerObjectType ?? undefined,
      },
    });
    return { status: "updated", recommendationId: existing.id };
  }

  try {
    const row = await prisma.autopilotCampaignRecommendation.create({
      data: {
        clientId,
        triggerType,
        triggerObjectType,
        triggerObjectId: effectiveObjectId,
        headline,
        whatWeNoticed,
        whyItMatters,
        recommendedChannels,
        recommendedAngles,
        payloadJson,
        expiresAt,
      },
      select: { id: true },
    });
    return { status: "created", recommendationId: row.id };
  } catch (err) {
    // Race with a concurrent detector run — the unique constraint
    // fired between our findFirst and create. Treat as noop.
    if (err?.code === "P2002") {
      const raced = await prisma.autopilotCampaignRecommendation.findFirst({
        where: { clientId, triggerType, triggerObjectId: effectiveObjectId },
        select: { id: true },
      });
      if (raced) return { status: "noop", recommendationId: raced.id };
    }
    throw err;
  }
}

/**
 * List recommendations for a workspace.
 *
 * Default filter excludes EXPIRED — the Inbox is for live
 * opportunities. Callers wanting the archive (history view) can
 * pass `includeExpired: true`. Pagination is offset-based to
 * match the existing inbox-list pattern.
 */
export async function listRecommendations({
  clientId,
  status,
  includeExpired = false,
  limit = 50,
  offset = 0,
} = {}) {
  if (!clientId) {
    throw Object.assign(new Error("clientId is required"), {
      status: 400,
      code: "BAD_INPUT",
    });
  }
  const where = { clientId };
  if (status && Array.isArray(status) && status.length > 0) {
    where.status = { in: status };
  } else if (status && typeof status === "string") {
    where.status = status;
  } else if (!includeExpired) {
    where.status = { not: "EXPIRED" };
  }

  const [rows, total] = await Promise.all([
    prisma.autopilotCampaignRecommendation.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.autopilotCampaignRecommendation.count({ where }),
  ]);

  return {
    recommendations: rows.map(toFrontendShape),
    total,
  };
}

/**
 * Counts the Campaign Inbox status pills render. Matches
 * AutopilotCampaignStatsResponse from the web hook layer.
 */
export async function getStats(clientId) {
  if (!clientId) return zeroStats();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const [pendingCount, readyCount, approvedThisWeek, dismissedThisWeek] =
    await Promise.all([
      prisma.autopilotCampaignRecommendation.count({
        where: { clientId, status: "NEEDS_REVIEW" },
      }),
      prisma.autopilotCampaignRecommendation.count({
        where: { clientId, status: "DRAFT_GENERATED" },
      }),
      prisma.autopilotCampaignRecommendation.count({
        where: {
          clientId,
          status: { in: ["APPROVED", "SCHEDULED"] },
          updatedAt: { gte: weekAgo },
        },
      }),
      prisma.autopilotCampaignRecommendation.count({
        where: {
          clientId,
          status: "DISMISSED",
          updatedAt: { gte: weekAgo },
        },
      }),
    ]);

  return {
    pendingCount,
    readyCount,
    approvedThisWeek,
    dismissedThisWeek,
    convertedThisWeek: 0, // reserved for Phase 4 convert path
  };
}

function zeroStats() {
  return {
    pendingCount: 0,
    readyCount: 0,
    approvedThisWeek: 0,
    dismissedThisWeek: 0,
    convertedThisWeek: 0,
  };
}

/**
 * Mark a recommendation DISMISSED.
 *
 * Idempotent — dismissing an already-dismissed rec is a noop,
 * not an error. Tenant-scoped by the route layer's
 * requireClientOwner + the where clause's clientId match.
 */
export async function dismissRecommendation({
  clientId,
  recommendationId,
  reason = null,
  actorSub = null,
}) {
  if (!clientId || !recommendationId) {
    throw Object.assign(new Error("clientId + recommendationId are required"), {
      status: 400,
      code: "BAD_INPUT",
    });
  }
  const rec = await prisma.autopilotCampaignRecommendation.findFirst({
    where: { id: recommendationId, clientId },
    select: { id: true, status: true },
  });
  if (!rec) {
    throw Object.assign(new Error("Recommendation not found"), {
      status: 404,
      code: "RECOMMENDATION_NOT_FOUND",
    });
  }
  if (rec.status === "DISMISSED") {
    // Idempotent — return the existing row unchanged.
    const current = await prisma.autopilotCampaignRecommendation.findUnique({
      where: { id: rec.id },
    });
    return toFrontendShape(current);
  }
  const updated = await prisma.autopilotCampaignRecommendation.update({
    where: { id: rec.id },
    data: {
      status: "DISMISSED",
      dismissedReason: reason,
      decidedBy: actorSub,
    },
  });
  return toFrontendShape(updated);
}

/**
 * Sweep expired recommendations — moves any NEEDS_REVIEW row past
 * expiresAt to EXPIRED so the Inbox doesn't show stale opportunities.
 * Called from the evaluator's tick. Returns the count flipped.
 */
export async function expireStaleRecommendations(clientId) {
  const now = new Date();
  const where = {
    expiresAt: { lt: now, not: null },
    status: { in: ["NEEDS_REVIEW", "DRAFT_GENERATED"] },
  };
  if (clientId) where.clientId = clientId;
  const result = await prisma.autopilotCampaignRecommendation.updateMany({
    where,
    data: { status: "EXPIRED" },
  });
  return result.count;
}

/**
 * Convert a DB row into the shape the FE
 * `AutopilotCampaignRecommendation` interface expects. The FE
 * shape is listing-centric; non-listing triggers (NEW_REVIEW,
 * INACTIVITY_GAP, etc.) ship empty property fields rather than
 * blow up the type — Phase 2.5 / Phase 3 can extend the FE.
 */
export function toFrontendShape(row) {
  if (!row) return null;
  const payload = (row.payloadJson && typeof row.payloadJson === "object") ? row.payloadJson : {};
  return {
    id: row.id,
    clientId: row.clientId,
    status: STATUS_BE_TO_FE[row.status] ?? "pending",
    triggerType: triggerToFe(row.triggerType),
    triggerReason: row.whatWeNoticed,
    triggeredAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    listingDataItemId:
      row.triggerObjectType === "listing" ? row.triggerObjectId ?? "" : "",
    propertyTitle: typeof payload.propertyTitle === "string" ? payload.propertyTitle : row.headline,
    propertyAddress:
      typeof payload.propertyAddress === "string" ? payload.propertyAddress : null,
    propertyData: (payload.propertyData && typeof payload.propertyData === "object") ? payload.propertyData : {},
    propertyImageUrl:
      typeof payload.propertyImageUrl === "string" ? payload.propertyImageUrl : null,
    suggestedCampaignType: row.headline,
    confidence:
      payload.confidence === "high" || payload.confidence === "medium" || payload.confidence === "low"
        ? payload.confidence
        : "medium",
    suggestedChannels: Array.isArray(row.recommendedChannels) ? row.recommendedChannels : [],
    generatedCampaign: null, // Phase 3
    postCount: Array.isArray(row.generatedDraftIds) ? row.generatedDraftIds.length : 0,
    approvedCampaignId: null, // Phase 4
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    expiresAt:
      row.expiresAt instanceof Date
        ? row.expiresAt.toISOString()
        : row.expiresAt ?? null,
    // Extra fields outside the strict FE interface — components
    // that need them (the detail modal) can read them off the row.
    headline: row.headline,
    whatWeNoticed: row.whatWeNoticed,
    whyItMatters: row.whyItMatters,
    recommendedAngles: Array.isArray(row.recommendedAngles) ? row.recommendedAngles : [],
    generatedDraftIds: Array.isArray(row.generatedDraftIds) ? row.generatedDraftIds : [],
    dismissedReason: row.dismissedReason ?? null,
    decidedBy: row.decidedBy ?? null,
  };
}

// Audit helper — kept here so routes can call it without an extra import
// per file. The route layer still wraps and supplies `req`.
export async function auditRecommendationEvent(req, action, recommendationId, metadata = {}) {
  await writeAudit(req, {
    action,
    resourceType: "AutopilotCampaignRecommendation",
    resourceId: recommendationId,
    metadata,
  });
}

// ── Phase 3 — generate drafts from a recommendation ───────────────────
//
// Given a NEEDS_REVIEW recommendation (or already DRAFT_GENERATED
// — idempotent case), plan per channel, call the existing
// generateDraft primitive once per channel, store the resulting
// Draft ids back on the recommendation, and flip status to
// DRAFT_GENERATED.
//
// Idempotency: if generatedDraftIds is already non-empty we
// return those drafts unchanged rather than firing a new
// fan-out — defense for double-clicks + the user re-opening the
// panel after a slow generation.

// Trigger-type → draft plan. Returns the per-channel angle, the
// templateType the existing aiGenerationService recognizes, and
// the media requirements.
function planForRecommendation(rec) {
  const payload =
    rec.payloadJson && typeof rec.payloadJson === "object" ? rec.payloadJson : {};
  const dataItemId =
    rec.triggerObjectType === "listing" ? rec.triggerObjectId : null;
  const propertyTitle =
    typeof payload.propertyTitle === "string" ? payload.propertyTitle : "your listing";
  const baseGuidance = (extra) =>
    `${rec.whatWeNoticed}\n\n${rec.whyItMatters}${extra ? `\n\n${extra}` : ""}`;

  switch (rec.triggerType) {
    case "NEW_LISTING":
      return {
        defaultChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
        requiresImage: ["INSTAGRAM"],
        items: [
          {
            angle: "just_listed",
            templateType: "just_listed",
            kind: "POST",
            guidance: baseGuidance(
              `Create a Just Listed post for ${propertyTitle}. Lead with the address + a single standout feature.`,
            ),
            dataItemId,
          },
        ],
      };
    case "OPEN_HOUSE":
      return {
        defaultChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
        requiresImage: ["INSTAGRAM"],
        items: [
          {
            angle: "open_house_invite",
            templateType: "open_house",
            kind: "POST",
            guidance: baseGuidance(
              `Open house invite for ${propertyTitle}. Include date/time + a single reason to attend.`,
            ),
            dataItemId,
          },
        ],
      };
    case "PRICE_DROP":
      return {
        defaultChannels: ["INSTAGRAM", "FACEBOOK"],
        requiresImage: ["INSTAGRAM"],
        items: [
          {
            angle: "price_drop_alert",
            templateType: "price_drop_alert",
            kind: "POST",
            guidance: baseGuidance(
              `Price reduction alert for ${propertyTitle}. Emphasize the new price + urgency.`,
            ),
            dataItemId,
          },
        ],
      };
    case "JUST_SOLD":
      return {
        defaultChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
        requiresImage: ["INSTAGRAM"],
        items: [
          {
            angle: "just_sold",
            templateType: "listing_post",
            kind: "POST",
            guidance: baseGuidance(
              `Just Sold success post for ${propertyTitle}. Celebrate the close without dollar amounts unless the seller approved sharing.`,
            ),
            dataItemId,
          },
        ],
      };
    case "STALE_LISTING":
      return {
        defaultChannels: ["INSTAGRAM", "FACEBOOK"],
        requiresImage: ["INSTAGRAM"],
        items: [
          {
            angle: "re_feature",
            templateType: "featured_property",
            kind: "POST",
            guidance: baseGuidance(
              `Re-introduce ${propertyTitle} with a fresh angle — buyer persona, lifestyle, or upgrade highlight.`,
            ),
            dataItemId,
          },
        ],
      };
    case "NEW_REVIEW":
      return {
        defaultChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
        requiresImage: [],
        items: [
          {
            angle: "testimonial_quote",
            templateType: "client_testimonial",
            kind: "POST",
            guidance: baseGuidance(
              `Testimonial post built around the recent ${payload.stars ?? "5"}-star review.`,
            ),
          },
        ],
      };
    case "INACTIVITY_GAP":
      return {
        defaultChannels: ["INSTAGRAM", "FACEBOOK"],
        requiresImage: [],
        items: [
          {
            angle: "evergreen_reactivation",
            templateType: "brand_authority",
            kind: "POST",
            // [NO_DATA_IDEA_POST] marker triggers aiGenerationService's
            // educational/idea path — no listing references invented.
            guidance:
              "[NO_DATA_IDEA_POST] " +
              baseGuidance(
                "Re-engagement post — share a piece of real-estate expertise that re-introduces your services without referencing a specific property.",
              ),
          },
        ],
      };
    default:
      return null;
  }
}

/**
 * Generate drafts for a recommendation.
 *
 * @returns {{
 *   status: 'success' | 'partial_success' | 'noop' | 'failed',
 *   drafts: Array<{id, channel, status, templateType}>,
 *   skipped: Array<{channel, reason}>,
 *   recommendation: object,
 *   recommendationId: string,
 *   alreadyGenerated?: boolean,
 *   reason?: string,
 * }}
 */
export async function generateDraftsForRecommendation({
  clientId,
  recommendationId,
  userId,
}) {
  if (!clientId || !recommendationId) {
    throw Object.assign(new Error("clientId + recommendationId are required"), {
      status: 400,
      code: "BAD_INPUT",
    });
  }

  const rec = await prisma.autopilotCampaignRecommendation.findFirst({
    where: { id: recommendationId, clientId },
  });
  if (!rec) {
    throw Object.assign(new Error("Recommendation not found"), {
      status: 404,
      code: "RECOMMENDATION_NOT_FOUND",
    });
  }
  if (rec.status === "DISMISSED" || rec.status === "EXPIRED") {
    throw Object.assign(
      new Error(`Cannot generate drafts for a ${rec.status} recommendation.`),
      { status: 412, code: "RECOMMENDATION_NOT_ELIGIBLE" },
    );
  }

  // Idempotency: if drafts already exist, return them unchanged.
  if (Array.isArray(rec.generatedDraftIds) && rec.generatedDraftIds.length > 0) {
    const existing = await prisma.draft.findMany({
      where: { id: { in: rec.generatedDraftIds }, clientId },
      select: { id: true, channel: true, status: true, bucketKey: true },
    });
    return {
      status: "noop",
      alreadyGenerated: true,
      drafts: existing.map((d) => ({
        id: d.id,
        channel: d.channel,
        status: d.status,
        templateType: d.bucketKey,
      })),
      skipped: [],
      recommendation: toFrontendShape(rec),
      recommendationId: rec.id,
    };
  }

  const plan = planForRecommendation(rec);
  if (!plan) {
    throw Object.assign(
      new Error(`No draft plan for trigger ${rec.triggerType} yet.`),
      { status: 501, code: "TRIGGER_NOT_SUPPORTED" },
    );
  }

  // Channel intersection: recommended ∩ enabled workspace channels.
  const enabledRows = await prisma.channelSettings.findMany({
    where: { clientId, isEnabled: true },
    select: { channel: true },
  });
  const enabled = new Set(enabledRows.map((r) => r.channel));
  const recommended =
    Array.isArray(rec.recommendedChannels) && rec.recommendedChannels.length > 0
      ? rec.recommendedChannels
      : plan.defaultChannels;

  const skipped = [];
  for (const c of recommended) {
    if (!enabled.has(c)) {
      skipped.push({ channel: c, reason: "Channel is not enabled for this workspace." });
    }
  }
  const candidateChannels = recommended.filter((c) => enabled.has(c));

  // Media-requirement gate. Today the only check is Instagram +
  // a propertyImageUrl in the payload. Future channels extend
  // via plan.requiresImage.
  const hasImage =
    typeof rec.payloadJson?.propertyImageUrl === "string" &&
    rec.payloadJson.propertyImageUrl.length > 0;
  const eligibleChannels = candidateChannels.filter((c) => {
    if (plan.requiresImage.includes(c) && !hasImage) {
      skipped.push({
        channel: c,
        reason: "Recommendation has no image; Instagram drafts need media.",
      });
      return false;
    }
    return true;
  });

  if (eligibleChannels.length === 0) {
    return {
      status: "failed",
      drafts: [],
      skipped,
      recommendation: toFrontendShape(rec),
      recommendationId: rec.id,
      reason:
        skipped.length > 0
          ? `No eligible channels: ${skipped.map((s) => `${s.channel} (${s.reason})`).join("; ")}`
          : "No channels available to generate drafts for.",
    };
  }

  const angle = plan.items[0];
  // Lazy-import to keep the read-side hot path cheap.
  const { generateDraft } = await import("./generation/aiGenerationService.js");
  const createdDrafts = [];
  for (const channel of eligibleChannels) {
    try {
      const draft = await generateDraft({
        clientId,
        kind: angle.kind,
        channel,
        bucketKey: angle.templateType,
        guidance: angle.guidance,
        templateType: angle.templateType,
        createdBy: "system:autopilot",
        dataItemId: angle.dataItemId ?? undefined,
        userId,
        recommendationId: rec.id,
        contentAngle: angle.angle,
      });
      // aiGenerationService returns a Draft with status=FAILED on
      // provider error rather than throwing. Don't count those.
      if (!draft || draft.status === "FAILED") {
        skipped.push({
          channel,
          reason: "Draft generation failed; see logs.",
        });
        continue;
      }
      createdDrafts.push({
        id: draft.id,
        channel: draft.channel,
        status: draft.status,
        templateType: draft.bucketKey ?? angle.templateType,
      });
    } catch (err) {
      console.error("[autopilot.rec.generate] generateDraft threw:", {
        clientId,
        recommendationId: rec.id,
        channel,
        err: err?.message,
      });
      skipped.push({ channel, reason: err?.message ?? "Generation error" });
    }
  }

  if (createdDrafts.length === 0) {
    // All channels failed — DO NOT flip status. The rec stays
    // NEEDS_REVIEW so the user can retry once the underlying
    // issue is resolved.
    return {
      status: "failed",
      drafts: [],
      skipped,
      recommendation: toFrontendShape(rec),
      recommendationId: rec.id,
      reason: "All channel generations failed.",
    };
  }

  // At least one success — store ids + flip status.
  const updated = await prisma.autopilotCampaignRecommendation.update({
    where: { id: rec.id },
    data: {
      status: "DRAFT_GENERATED",
      generatedDraftIds: createdDrafts.map((d) => d.id),
    },
  });

  return {
    status: skipped.length > 0 ? "partial_success" : "success",
    drafts: createdDrafts,
    skipped,
    recommendation: toFrontendShape(updated),
    recommendationId: rec.id,
  };
}
