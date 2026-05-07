// Tiny pure helper used by POST /workspaces/:id/auto-schedule.
// Splits the user-submitted draft ids into "owned" (will be attempted)
// and "rejected" buckets, then classifies the post-attempt rejections
// into ownership-vs-state for telemetry.
//
// Kept separate so the route handler stays small and the rejected-count
// math is unit-testable without booting the full studio router.

/**
 * @param {object} args
 * @param {string[]} args.submittedIds         — every id the client sent
 * @param {Set<string>} args.ownedIdSet        — ids confirmed to live in the workspace
 * @param {number} args.scheduledCount         — drafts the service successfully scheduled
 * @returns {{
 *   ownedIds: string[],
 *   ownershipRejected: number,
 *   stateRejected: number,
 *   rejectedCount: number,
 *   rejectedReason: string | null
 * }}
 */
export function classifyAutoScheduleResult({ submittedIds, ownedIdSet, scheduledCount }) {
  const ownedIds = submittedIds.filter((id) => ownedIdSet.has(id));
  const ownershipRejected = submittedIds.length - ownedIds.length;
  const stateRejected = ownedIds.length - scheduledCount;
  const rejectedCount = ownershipRejected + stateRejected;

  return {
    ownedIds,
    ownershipRejected,
    stateRejected,
    rejectedCount,
    // Public-facing reason intentionally generic — never reveals
    // whether a rejection was for ownership or state. That distinction
    // would let a caller probe workspace ownership by id.
    rejectedReason:
      rejectedCount > 0
        ? "Some drafts were invalid or unavailable and were not scheduled."
        : null,
  };
}
