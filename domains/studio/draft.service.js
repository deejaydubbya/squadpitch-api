// Squadpitch draft reads + edits.
//
// Owns CRUD-style reads and patches on Draft. State-machine
// transitions (approve / reject / schedule / publish) live in
// draftWorkflow.service.js which also writes the ModerationLog.

import { prisma } from "../../prisma.js";

const DRAFT_ASSET_INCLUDE = {
  draftAssets: {
    include: { asset: { select: { id: true, url: true, thumbnailUrl: true, assetType: true, filename: true } } },
    orderBy: { orderIndex: "asc" },
  },
};

export async function listDrafts({
  clientId,
  // Optional list of client IDs to scope the query to. The route handler
  // populates this with the authenticated user's owned clients when no
  // `clientId` filter is supplied — without it the route would return
  // every draft in the database. Tenant-isolation defence.
  clientIds,
  status,
  kind,
  channel,
  limit = 50,
  cursor,
}) {
  return prisma.draft.findMany({
    where: {
      ...(clientId && { clientId }),
      ...(!clientId && Array.isArray(clientIds) && { clientId: { in: clientIds } }),
      ...(status && { status }),
      ...(kind && { kind }),
      ...(channel && { channel }),
    },
    include: DRAFT_ASSET_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: limit,
    ...(cursor && { skip: 1, cursor: { id: cursor } }),
  });
}

export async function getDraft(draftId) {
  return prisma.draft.findUnique({
    where: { id: draftId },
    include: DRAFT_ASSET_INCLUDE,
  });
}

/**
 * Update an editable draft. Only allowed while the draft is still in
 * DRAFT or PENDING_REVIEW — anything further along in the pipeline is
 * locked for audit purposes.
 */
export async function updateDraft(draftId, patch) {
  const existing = await prisma.draft.findUnique({
    where: { id: draftId },
  });
  if (!existing) {
    throw Object.assign(new Error("Draft not found"), { status: 404 });
  }
  // Editability rule: a draft is editable as long as it has not
  // actually been published anywhere. This covers the common
  // "Approved → publish failed → fix media → retry" flow that the
  // strict status-whitelist used to block. Once a post has reached a
  // social platform (externalPostId set, or publishedAt stamped) we
  // refuse the edit — at that point the right action is to delete and
  // re-create.
  const alreadyPublished =
    existing.externalPostId != null || existing.publishedAt != null;
  if (alreadyPublished) {
    throw Object.assign(
      new Error(
        `Cannot edit a draft that has already been published (status ${existing.status}).`
      ),
      { status: 409 }
    );
  }

  const draft = await prisma.draft.update({
    where: { id: draftId },
    data: {
      ...(patch.body !== undefined && { body: patch.body }),
      ...(patch.hooks !== undefined && { hooks: patch.hooks }),
      ...(patch.hashtags !== undefined && { hashtags: patch.hashtags }),
      ...(patch.cta !== undefined && { cta: patch.cta }),
      ...(patch.altText !== undefined && { altText: patch.altText }),
      ...(patch.channel !== undefined && { channel: patch.channel }),
      ...(patch.mediaUrl !== undefined && { mediaUrl: patch.mediaUrl, mediaType: patch.mediaUrl ? "image" : null }),
    },
  });

  // Sync DraftAsset rows when mediaAssetIds are provided
  if (Array.isArray(patch.mediaAssetIds)) {
    console.log('[MEDIA SAVE] updateDraft received mediaAssetIds', patch.mediaAssetIds);

    // Remove existing DraftAsset rows for this draft
    await prisma.draftAsset.deleteMany({ where: { draftId } });

    if (patch.mediaAssetIds.length > 0) {
      // Validate assets belong to the draft's workspace
      const validAssets = await prisma.mediaAsset.findMany({
        where: { id: { in: patch.mediaAssetIds }, clientId: existing.clientId },
        select: { id: true, url: true, assetType: true },
      });
      const validAssetMap = new Map(validAssets.map((a) => [a.id, a]));
      const validIds = patch.mediaAssetIds.filter((id) => validAssetMap.has(id));

      if (validIds.length === 0) {
        console.log('[MEDIA SAVE] updateDraft — no valid assets found for workspace', existing.clientId);
      }

      if (validIds.length > 0) {
        // Create new rows
        await prisma.draftAsset.createMany({
          data: validIds.map((assetId, i) => ({
            draftId,
            assetId,
            role: i === 0 ? "primary" : null,
            orderIndex: i,
          })),
        });

        // Hydrate draft.mediaUrl from the primary asset
        const primary = validAssetMap.get(validIds[0]);
        console.log('[MEDIA SAVE] updateDraft primary asset', primary?.id, primary?.url);
        if (primary?.url) {
          await prisma.draft.update({
            where: { id: draftId },
            data: {
              mediaUrl: primary.url,
              mediaType: primary.assetType ?? "image",
            },
          });
          draft.mediaUrl = primary.url;
          draft.mediaType = primary.assetType ?? "image";
        }
      }
    }
    console.log('[MEDIA SAVE] updateDraft returning', draft.mediaUrl, draft.mediaType);

    // Re-fetch to ensure the response includes hydrated mediaUrl
    const freshDraft = await prisma.draft.findUnique({ where: { id: draftId } });
    if (freshDraft) return freshDraft;
  }

  return draft;
}

export async function deleteDraft(draftId) {
  return prisma.draft.delete({ where: { id: draftId } });
}

export async function duplicateDraft(draftId, createdBy) {
  const src = await prisma.draft.findUnique({
    where: { id: draftId },
  });
  if (!src) throw Object.assign(new Error("Draft not found"), { status: 404 });

  return prisma.draft.create({
    data: {
      clientId: src.clientId,
      kind: src.kind,
      status: "DRAFT",
      channel: src.channel,
      bucketKey: src.bucketKey,
      generationGuidance: src.generationGuidance,
      modelUsed: src.modelUsed,
      promptVersion: src.promptVersion,
      body: src.body,
      hooks: src.hooks,
      hashtags: src.hashtags,
      cta: src.cta,
      variations: src.variations,
      altText: src.altText,
      imageGuidance: src.imageGuidance,
      videoGuidance: src.videoGuidance,
      mediaUrl: src.mediaUrl,
      mediaType: src.mediaType,
      warnings: [],
      createdBy,
    },
  });
}

export async function deleteDraftsByClient(clientId) {
  return prisma.draft.deleteMany({ where: { clientId } });
}

/**
 * Parse warnings array into structured source metadata for the frontend.
 */
function parseSourceMeta(warnings, createdBy) {
  const isAutopilot = createdBy === "system:autopilot";
  const isAutoGen = createdBy === "system:auto_generate";

  if (!Array.isArray(warnings) || warnings.length === 0) {
    if (isAutopilot) return { autopilot: true };
    if (isAutoGen) return { autoGenerated: true, source: "listing" };
    return undefined;
  }

  const meta = {};

  for (const w of warnings) {
    if (w.startsWith("re_auto_listing:")) {
      meta.source = "listing";
      meta.listingTitle = w.slice("re_auto_listing:".length).trim();
    } else if (w.startsWith("re_assets:")) {
      meta.assets = w.slice("re_assets:".length).trim();
    } else if (w === "re_rotation: applied") {
      meta.rotated = true;
    } else if (w.startsWith("re_fallback:")) {
      meta.source = "fallback";
    } else if (w.startsWith("recommendation:")) {
      meta.recommendationId = w.slice("recommendation:".length).trim();
    } else if (w.startsWith("auto_blueprint:")) {
      meta.autoBlueprint = w.slice("auto_blueprint:".length).trim();
    // Autopilot-specific warnings
    } else if (w === "autopilot: true") {
      meta.autopilot = true;
    } else if (w.startsWith("autopilot_trigger:")) {
      meta.autopilotTrigger = w.slice("autopilot_trigger:".length).trim();
    } else if (w.startsWith("autopilot_reason:")) {
      meta.autopilotReason = w.slice("autopilot_reason:".length).trim();
    } else if (w.startsWith("autopilot_channel:")) {
      meta.autopilotChannel = w.slice("autopilot_channel:".length).trim();
    } else if (w.startsWith("autopilot_asset:")) {
      meta.autopilotAsset = w.slice("autopilot_asset:".length).trim();
    } else if (w.startsWith("autopilot_mode:")) {
      meta.autopilotMode = w.slice("autopilot_mode:".length).trim();
    } else if (w.startsWith("autopilot_angle_label:")) {
      meta.contentAngle = w.slice("autopilot_angle_label:".length).trim();
    } else if (w.startsWith("autopilot_angle:")) {
      meta.contentAngleKey = w.slice("autopilot_angle:".length).trim();
    // Listing campaign warnings
    } else if (w === "source:listing-campaign") {
      meta.source = "listing";
      meta.listingCampaign = true;
    } else if (w.startsWith("address:")) {
      meta.listingTitle = w.slice("address:".length).trim();
    } else if (w.startsWith("campaignType:")) {
      meta.campaignType = w.slice("campaignType:".length).trim();
    }
  }

  if (!meta.source) {
    if (meta.listingTitle) meta.source = "listing";
    else if (meta.autopilotReason?.includes("listing")) meta.source = "listing";
    else if (meta.autopilotReason?.includes("review")) meta.source = "review";
    else if (meta.autopilotReason?.includes("fallback")) meta.source = "fallback";
    else if (warnings.some((w) =>
      w.startsWith("source:review") || w.startsWith("source:testimonial") ||
      w === "review" || w === "testimonial"
    )) meta.source = "review";
  }

  if (isAutopilot) meta.autopilot = true;
  if (isAutoGen) meta.autoGenerated = true;

  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function formatDraft(draft) {
  if (!draft) return null;

  const sourceMeta = parseSourceMeta(draft.warnings, draft.createdBy);

  return {
    id: draft.id,
    clientId: draft.clientId,
    kind: draft.kind,
    status: draft.status,
    channel: draft.channel,
    bucketKey: draft.bucketKey,
    generationGuidance: draft.generationGuidance,
    modelUsed: draft.modelUsed,
    promptVersion: draft.promptVersion,
    body: draft.body,
    hooks: draft.hooks ?? [],
    hashtags: draft.hashtags ?? [],
    cta: draft.cta,
    variations: draft.variations ?? null,
    scoredHooks: draft.scoredHooks ?? null,
    altText: draft.altText,
    imageGuidance: draft.imageGuidance ?? null,
    videoGuidance: draft.videoGuidance ?? null,
    mediaPlan: draft.mediaPlan ?? null,
    warnings: draft.warnings ?? [],
    ...(sourceMeta && { sourceMeta }),
    mediaUrl: draft.mediaUrl ?? null,
    mediaType: draft.mediaType ?? null,
    externalPostId: draft.externalPostId ?? null,
    externalPostUrl: draft.externalPostUrl ?? null,
    publishError: draft.publishError ?? null,
    publishAttempts: draft.publishAttempts ?? 0,
    lastPublishAttemptAt: draft.lastPublishAttemptAt ?? null,
    publishSource: draft.publishSource ?? null,
    performanceRating: draft.performanceRating ?? null,
    ratedAt: draft.ratedAt ?? null,
    createdBy: draft.createdBy,
    approvedBy: draft.approvedBy,
    approvedAt: draft.approvedAt,
    rejectedReason: draft.rejectedReason,
    scheduledFor: draft.scheduledFor,
    publishedAt: draft.publishedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    // Linked media assets (from DraftAsset join table)
    mediaAssets: (draft.draftAssets ?? []).map((da) => ({
      id: da.asset.id,
      url: da.asset.url,
      thumbnailUrl: da.asset.thumbnailUrl ?? null,
      assetType: da.asset.assetType ?? "image",
      filename: da.asset.filename ?? null,
      role: da.role,
      orderIndex: da.orderIndex,
    })),
    // Campaign fields
    campaignId: draft.campaignId ?? null,
    campaignName: draft.campaignName ?? null,
    campaignType: draft.campaignType ?? null,
    campaignDay: draft.campaignDay ?? null,
    campaignOrder: draft.campaignOrder ?? null,
    campaignTotal: draft.campaignTotal ?? null,
  };
}
