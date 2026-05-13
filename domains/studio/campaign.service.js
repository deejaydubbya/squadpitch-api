// Campaign service helpers.
//
// Server-side equivalents of squadpitch-web's
// lib/assistant/campaignLifecycle.ts, with output mapped to the
// CampaignStatus Prisma enum instead of the web-side UI keys.
// Used by the backfill script and by save-drafts to seed
// Campaign.status from the drafts that hang off it.

/**
 * Roll up a group's draft statuses into a single CampaignStatus.
 *
 * Mirrors computeCampaignLifecycle() on the web (which renders the
 * Planner lifecycle chip) but emits the enum values:
 *   DRAFT | PENDING_REVIEW | SCHEDULED | PUBLISHING |
 *   PUBLISHED | ARCHIVED | FAILED
 *
 * ARCHIVED is never inferred — it's an explicit user action, never
 * a rollup. The web mapping's "mixed"/"In Progress" state collapses
 * to DRAFT here so the enum stays clean (UI keeps the live
 * computeCampaignLifecycle for the chip — Campaign.status is a
 * coarser persistent snapshot).
 *
 * @param {Array<{status: string}>} drafts
 * @returns {string} CampaignStatus enum value
 */
export function inferStatusFromDraftStatuses(drafts) {
  if (!Array.isArray(drafts) || drafts.length === 0) return "DRAFT";

  const counts = Object.create(null);
  for (const d of drafts) {
    if (!d || !d.status) continue;
    counts[d.status] = (counts[d.status] || 0) + 1;
  }
  const total = drafts.length;
  const has = (s) => (counts[s] || 0) > 0;

  if ((counts.FAILED || 0) === total) return "FAILED";
  if ((counts.PUBLISHED || 0) === total) return "PUBLISHED";
  if ((counts.PUBLISHED || 0) > 0 && (counts.SCHEDULED || 0) > 0) return "PUBLISHING";
  if ((counts.SCHEDULED || 0) === total) return "SCHEDULED";
  if ((counts.PENDING_REVIEW || 0) > 0) return "PENDING_REVIEW";
  // Any combo of DRAFT/APPROVED/PENDING_REVIEW/SCHEDULED that
  // doesn't hit the above (e.g. some scheduled, some still draft)
  // falls to DRAFT — coarser-grained than the UI's
  // partially_scheduled / mixed states, but accurate enough for
  // persistent rollup. The UI keeps live precision.
  if (has("SCHEDULED")) return "SCHEDULED";
  return "DRAFT";
}

/**
 * Decide a Campaign's initial status at save-drafts time.
 *
 *   Approve & Schedule (addToPlanner = true)         → SCHEDULED
 *   Save as Drafts + alwaysRequireReview (default)  → PENDING_REVIEW
 *   Save as Drafts + opted-out workspace             → DRAFT
 */
export function initialCampaignStatus({ addToPlanner, alwaysRequireReview }) {
  if (addToPlanner) return "SCHEDULED";
  return alwaysRequireReview === false ? "DRAFT" : "PENDING_REVIEW";
}

/**
 * Serialize a Campaign row to the API shape consumed by the web
 * client. Stable shape so the frontend interface in
 * squadpitch-web/src/hooks/useSquadpitch.ts can rely on it.
 */
export function formatCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    campaignType: row.campaignType,
    sourceType: row.sourceType ?? null,
    sourceDataItemId: row.sourceDataItemId ?? null,
    sourceTitle: row.sourceTitle ?? null,
    campaignIdea: row.campaignIdea ?? null,
    status: row.status,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    metadataJson: row.metadataJson ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
