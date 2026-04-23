import { sendError } from "../lib/apiErrors.js";

const ROLES_CLAIM = "https://mivalta.com/roles";

/**
 * Read Auth0 roles from the JWT custom claim.
 * Returns an array of role strings (e.g. ["admin", "developer"]).
 */
export function getUserRoles(req) {
  const roles = req.auth?.payload?.[ROLES_CLAIM];
  return Array.isArray(roles) ? roles : [];
}

/**
 * Generic middleware factory: requires at least one of the specified roles.
 * Usage: router.use(requireRole(["admin", "developer"]))
 */
export function requireRole(allowedRoles) {
  return (req, res, next) => {
    const roles = getUserRoles(req);
    const hasAllowed = allowedRoles.some((r) => roles.includes(r));
    if (!hasAllowed) {
      return sendError(res, 403, "FORBIDDEN", `One of [${allowedRoles.join(", ")}] role required`);
    }
    req.roles = roles;
    next();
  };
}

/**
 * Middleware: requires the user to have either "admin" or "developer" role.
 * Convenience wrapper for the internal admin console.
 */
export const requireInternalAccess = requireRole(["admin", "developer"]);

/**
 * Middleware: requires the "admin" role specifically.
 * Used for destructive or sensitive operations (config changes, etc.).
 */
export const requireAdminRole = requireRole(["admin"]);
