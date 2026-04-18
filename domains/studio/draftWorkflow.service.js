// State-machine transitions for Squadpitch drafts.
//
// Owns the ModerationLog writes and enforces the allowed
// transitions. Publishing in v1 is local-only (marks PUBLISHED +
// sets publishedAt) — no external platform push.

import { prisma } from "../../prisma.js";

export const VALID_TRANSITIONS = {
  DRAFT: ["PENDING_REVIEW", "APPROVED", "REJECTED"],
  PENDING_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["SCHEDULED", "PUBLISHED", "REJECTED"],
  SCHEDULED: ["SCHEDULED", "PUBLISHED", "APPROVED", "REJECTED", "FAILED"],
  PUBLISHED: [],
  REJECTED: ["DRAFT"],
  FAILED: ["DRAFT"],
};

function assertTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw Object.assign(
      new Error(`Cannot transition draft from ${from} to ${to}`),
      { status: 400, code: "INVALID_TRANSITION" }
    );
  }
}

/**
 * Transition a draft to a new status with an audit log row.
 *
 * @param {string} draftId
 * @param {string} toStatus
 * @param {string} actorSub
 * @param {object} [extras] - extra columns to set on the draft
 * @param {string} [reason]
 */
export async function transitionDraft(
  draftId,
  toStatus,
  actorSub,
  extras = {},
  reason = null
) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.draft.findUnique({
      where: { id: draftId },
    });
    if (!draft) {
      throw Object.assign(new Error("Draft not found"), { status: 404 });
    }
    assertTransition(draft.status, toStatus);

    const updated = await tx.draft.update({
      where: { id: draftId },
      data: {
        status: toStatus,
        ...extras,
      },
    });

    await tx.moderationLog.create({
      data: {
        draftId,
        clientId: draft.clientId,
        fromStatus: draft.status,
        toStatus,
        actorSub,
        reason,
      },
    });

    return updated;
  });
}

export async function approveDraft(draftId, actorSub) {
  return transitionDraft(draftId, "APPROVED", actorSub, {
    approvedBy: actorSub,
    approvedAt: new Date(),
  });
}

export async function rejectDraft(draftId, reason, actorSub) {
  return transitionDraft(
    draftId,
    "REJECTED",
    actorSub,
    { rejectedReason: reason },
    reason
  );
}

export async function scheduleDraft(draftId, scheduledFor, actorSub) {
  return transitionDraft(draftId, "SCHEDULED", actorSub, {
    scheduledFor: new Date(scheduledFor),
  });
}

/**
 * Mark a draft as PUBLISHED. In v1 this is a local state change only —
 * no external platform push. Scheduled publishing worker / external
 * publishing pipeline comes in a later pass.
 */
export async function publishDraft(draftId, actorSub) {
  return transitionDraft(draftId, "PUBLISHED", actorSub, {
    publishedAt: new Date(),
  });
}
