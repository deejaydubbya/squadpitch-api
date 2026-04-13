import { env } from "../config/env.js";
import { sendError } from "../lib/apiErrors.js";

const adminIds = new Set(
  (env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * Express middleware that restricts access to admin users.
 * Checks req.user.id against ADMIN_USER_IDS env var.
 */
export function requireAdmin(req, res, next) {
  if (!req.user?.id || !adminIds.has(req.user.id)) {
    return sendError(res, 403, "FORBIDDEN", "Admin access required");
  }
  next();
}
