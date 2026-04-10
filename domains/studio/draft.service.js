// Squadpitch draft reads + edits.
//
// Owns CRUD-style reads and patches on Draft. State-machine
// transitions (approve / reject / schedule / publish) live in
// draftWorkflow.service.js which also writes the ModerationLog.

import { prisma } from "../../prisma.js";

export async function listDrafts({
  clientId,
  status,
  kind,
  channel,
  limit = 50,
  cursor,
}) {
  return prisma.draft.findMany({
    where: {
      ...(clientId && { clientId }),
      ...(status && { status }),
      ...(kind && { kind }),
      ...(channel && { channel }),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    ...(cursor && { skip: 1, cursor: { id: cursor } }),
  });
}

export async function getDraft(draftId) {
  return prisma.draft.findUnique({
    where: { id: draftId },
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
  if (!["DRAFT", "PENDING_REVIEW"].includes(existing.status)) {
    throw Object.assign(
      new Error(`Cannot edit a draft with status ${existing.status}`),
      { status: 409 }
    );
  }

  return prisma.draft.update({
    where: { id: draftId },
    data: {
      ...(patch.body !== undefined && { body: patch.body }),
      ...(patch.hooks !== undefined && { hooks: patch.hooks }),
      ...(patch.hashtags !== undefined && { hashtags: patch.hashtags }),
      ...(patch.cta !== undefined && { cta: patch.cta }),
      ...(patch.altText !== undefined && { altText: patch.altText }),
    },
  });
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
      warnings: [],
      createdBy,
    },
  });
}

export async function deleteDraftsByClient(clientId) {
  return prisma.draft.deleteMany({ where: { clientId } });
}

export function formatDraft(draft) {
  if (!draft) return null;
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
    altText: draft.altText,
    imageGuidance: draft.imageGuidance ?? null,
    warnings: draft.warnings ?? [],
    mediaUrl: draft.mediaUrl ?? null,
    mediaType: draft.mediaType ?? null,
    externalPostId: draft.externalPostId ?? null,
    externalPostUrl: draft.externalPostUrl ?? null,
    publishError: draft.publishError ?? null,
    publishAttempts: draft.publishAttempts ?? 0,
    lastPublishAttemptAt: draft.lastPublishAttemptAt ?? null,
    publishSource: draft.publishSource ?? null,
    createdBy: draft.createdBy,
    approvedBy: draft.approvedBy,
    approvedAt: draft.approvedAt,
    rejectedReason: draft.rejectedReason,
    scheduledFor: draft.scheduledFor,
    publishedAt: draft.publishedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}
