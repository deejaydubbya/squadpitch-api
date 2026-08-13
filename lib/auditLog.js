// Append-only audit log writer for admin/developer mutations.
//
// Usage from a route handler:
//   await writeAudit(req, {
//     action: "flag.toggle",
//     resourceType: "FeatureFlag",
//     resourceId: flag.id,
//     metadata: { from: prev.enabled, to: next.enabled },
//   });
//
// All writes are best-effort — a logging failure must NEVER fail the
// originating mutation. We catch + console.error and move on.
//
// `metadata` is JSON-serialised by Prisma. We aggressively redact known
// sensitive keys before write so a stray "secret" or "accessToken" can't
// land in the audit table. Schema-level guarantees aren't possible on a
// Json column, so the discipline lives here.

import { prisma } from "../prisma.js";

const SENSITIVE_KEYS = new Set([
  "accessToken",
  "refreshToken",
  "token",
  "claimToken",
  "previewToken",
  "claimTokenHash",
  "previewTokenHash",
  "secret",
  "auth",
  "p256dh",
  "password",
  "apiKey",
  "apiSecret",
  "clientSecret",
  "stripeSecretKey",
  "webhookSignature",
]);

function redact(obj, depth = 0) {
  if (obj === null || obj === undefined) return obj;
  if (depth > 6) return "[TRUNCATED]"; // defensive: don't recurse into pathological shapes
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = redact(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Write an audit row for a mutation made by an admin/developer.
 *
 * @param {import("express").Request} req — must have come through requireAuth+requireUser
 * @param {{
 *   action: string,
 *   resourceType: string,
 *   resourceId?: string | null,
 *   metadata?: Record<string, unknown> | null,
 * }} entry
 */
export async function writeAudit(req, entry) {
  if (!entry || !entry.action || !entry.resourceType) return;

  try {
    await prisma.auditLog.create({
      data: {
        actorSub: req.auth?.payload?.sub ?? "unknown",
        actorEmail: req.user?.email ?? null,
        actorRoles: Array.isArray(req.roles) ? req.roles : [],
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        route: req.method && req.originalUrl ? `${req.method} ${req.originalUrl}` : null,
        metadata: entry.metadata ? redact(entry.metadata) : null,
        ip: req.ip ?? null,
        userAgent: req.get?.("user-agent") ?? null,
      },
    });
  } catch (err) {
    // Never fail the underlying request because audit logging blew up.
    // Surface to ops via the request logger so we know to investigate.
    req.log?.error?.(
      { auditAction: entry.action, err: err?.message ?? err },
      "audit_write_failed"
    );
  }
}

/** Test-only helpers exposed via the same module. */
export const _internal = { redact, SENSITIVE_KEYS };
