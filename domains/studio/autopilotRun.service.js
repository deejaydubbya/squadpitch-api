// Autopilot run history — start/finish/list.
//
// Phase 5 of docs/AUTOPILOT_PRODUCT_AUDIT.md.
//
// One row per evaluator pass. The activity surface reads these
// rows so the workspace owner can see "ran 3h ago — found 2 new
// opportunities" or "skipped: no channels connected" instead of
// just per-draft history.

import { prisma } from "../../prisma.js";

/**
 * Begin a run. Returns the AutopilotRun id so the caller can
 * later `finishRun(id, outcome)`. status is set to NO_ACTION as
 * a placeholder; finishRun overrides it.
 */
export async function startRun({
  clientId,
  triggerSource,
  settingsSnapshot = null,
  readinessSnapshot = null,
}) {
  if (!clientId || !triggerSource) {
    throw Object.assign(new Error("clientId + triggerSource required"), {
      status: 400,
      code: "BAD_INPUT",
    });
  }
  const row = await prisma.autopilotRun.create({
    data: {
      clientId,
      triggerSource,
      status: "NO_ACTION",
      settingsSnapshot: settingsSnapshot ?? undefined,
      readinessSnapshot: readinessSnapshot ?? undefined,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Finalize a run with its outcome counts + status. Best-effort:
 * a write failure here must NOT fail the evaluator. We swallow
 * + log so the caller's outcome is the one the user sees.
 */
export async function finishRun(
  runId,
  {
    status = "NO_ACTION",
    reason = null,
    recommendationsCreated = 0,
    recommendationsUpdated = 0,
    recommendationsExpired = 0,
    errorMessage = null,
    metadata = null,
  } = {},
) {
  if (!runId) return;
  try {
    await prisma.autopilotRun.update({
      where: { id: runId },
      data: {
        status,
        reason,
        recommendationsCreated,
        recommendationsUpdated,
        recommendationsExpired,
        errorMessage,
        metadata: metadata ?? undefined,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn("[autopilot.run] finishRun failed:", {
      runId,
      err: err?.message,
    });
  }
}

/**
 * Convenience: synchronous-style wrapper that opens a run,
 * executes `fn`, and finishes the run with the returned outcome
 * shape. If `fn` throws, records ERROR + rethrows so the route
 * layer can surface the original error to the user.
 *
 * `fn` should return an object the recorder turns into the run's
 * outcome:
 *   { status, reason, recommendationsCreated, recommendationsUpdated,
 *     recommendationsExpired, metadata? }
 */
export async function recordRun(
  { clientId, triggerSource, settingsSnapshot = null, readinessSnapshot = null },
  fn,
) {
  const runId = await startRun({
    clientId,
    triggerSource,
    settingsSnapshot,
    readinessSnapshot,
  }).catch(() => null);
  try {
    const outcome = await fn(runId);
    await finishRun(runId, outcome ?? {});
    return outcome;
  } catch (err) {
    await finishRun(runId, {
      status: "ERROR",
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

/**
 * Paginated run history for the workspace. Defaults: 25 per
 * page, most-recent-first. Empty workspace returns an empty
 * array (not 404).
 */
export async function listRuns({ clientId, limit = 25, offset = 0 } = {}) {
  if (!clientId) {
    throw Object.assign(new Error("clientId is required"), {
      status: 400,
      code: "BAD_INPUT",
    });
  }
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const [rows, total] = await Promise.all([
    prisma.autopilotRun.findMany({
      where: { clientId },
      orderBy: { startedAt: "desc" },
      take: safeLimit,
      skip: Math.max(offset, 0),
      select: {
        id: true,
        triggerSource: true,
        status: true,
        reason: true,
        recommendationsCreated: true,
        recommendationsUpdated: true,
        recommendationsExpired: true,
        startedAt: true,
        finishedAt: true,
        errorMessage: true,
        metadata: true,
      },
    }),
    prisma.autopilotRun.count({ where: { clientId } }),
  ]);
  return {
    runs: rows.map((r) => ({
      id: r.id,
      triggerSource: String(r.triggerSource).toLowerCase(),
      status: String(r.status).toLowerCase(),
      reason: r.reason,
      recommendationsCreated: r.recommendationsCreated,
      recommendationsUpdated: r.recommendationsUpdated,
      recommendationsExpired: r.recommendationsExpired,
      startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : r.startedAt,
      finishedAt:
        r.finishedAt instanceof Date ? r.finishedAt.toISOString() : r.finishedAt,
      errorMessage: r.errorMessage,
      // Spinstr04 — explainability surface. Pass the run-time
      // metadata (skip reasons, summary counts, autoGenerate
      // results) through to the activity panel so it can render
      // rich plain-English rows instead of bare reason strings.
      // Privacy: only structured counts + ids land here; the
      // detector deliberately never writes user-identifying data
      // into metadata.
      metadata: sanitizeRunMetadata(r.metadata),
    })),
    total,
  };
}

// Whitelist of top-level metadata keys the API exposes. Anything
// the detector hasn't added to this list stays internal. Keeps
// future detector experiments from accidentally leaking through.
const SAFE_METADATA_KEYS = new Set([
  "summary",
  "autoGenerate",
  "schedulerTickId",
]);

function sanitizeRunMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const safe = {};
  let any = false;
  for (const key of SAFE_METADATA_KEYS) {
    if (key in value) {
      safe[key] = value[key];
      any = true;
    }
  }
  return any ? safe : null;
}
