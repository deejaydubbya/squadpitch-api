import { prisma } from "../../prisma.js";

export const WORKSPACE_AUTH_SCOPES = Object.freeze([
  "health:read",
  "eval:run",
  "retrieval:query",
  "campaign-plan:read",
  "autopilot-rank:read",
  "content-score:read",
]);

export const WORKSPACE_AUTH_DECISION = Object.freeze({
  ALLOW: "ALLOW",
  DENY: "DENY",
});

export const WORKSPACE_AUTH_REASON = Object.freeze({
  ALLOWED_OWNER: "ALLOWED_OWNER",
  ALLOWED_ADMIN: "ALLOWED_ADMIN",
  ACTOR_MISSING: "ACTOR_MISSING",
  WORKSPACE_MISSING: "WORKSPACE_MISSING",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  SCOPE_DENIED: "SCOPE_DENIED",
  NOT_WORKSPACE_OWNER: "NOT_WORKSPACE_OWNER",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  RESOURCE_WORKSPACE_MISMATCH: "RESOURCE_WORKSPACE_MISMATCH",
});

const DEFAULT_OWNER_SCOPE_PREFIXES = Object.freeze([
  "eval:",
  "retrieval:",
  "campaign-plan:",
  "autopilot-rank:",
  "content-score:",
]);

function normalizeRoles(actor) {
  return Array.isArray(actor?.roles) ? actor.roles : [];
}

function actorIdForWorkspaceOwnership(actor) {
  return actor?.auth0Sub ?? actor?.sub ?? null;
}

function isKnownWorkspaceScope(scope) {
  return WORKSPACE_AUTH_SCOPES.includes(scope);
}

function isOwnerScope(scope) {
  return DEFAULT_OWNER_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix));
}

function denied(reason, details = {}) {
  return {
    allowed: false,
    decision: WORKSPACE_AUTH_DECISION.DENY,
    reason,
    ...details,
  };
}

function allowed(reason, details = {}) {
  return {
    allowed: true,
    decision: WORKSPACE_AUTH_DECISION.ALLOW,
    reason,
    ...details,
  };
}

export async function canActorPerformWorkspaceScope({
  actor,
  workspaceId,
  scope,
  allowAdmin = false,
  adminRoles = ["admin"],
  prismaClient = prisma,
  roleResolver,
} = {}) {
  const actorSub = actorIdForWorkspaceOwnership(actor);
  if (!actorSub) return denied(WORKSPACE_AUTH_REASON.ACTOR_MISSING);
  if (!workspaceId || typeof workspaceId !== "string") {
    return denied(WORKSPACE_AUTH_REASON.WORKSPACE_MISSING);
  }
  if (!isKnownWorkspaceScope(scope) || !isOwnerScope(scope)) {
    return denied(WORKSPACE_AUTH_REASON.SCOPE_DENIED, { actorId: actorSub, workspaceId, scope });
  }

  const workspace = await prismaClient.client.findUnique({
    where: { id: workspaceId },
    select: { id: true, createdBy: true },
  });
  if (!workspace) {
    return denied(WORKSPACE_AUTH_REASON.WORKSPACE_NOT_FOUND, { actorId: actorSub, workspaceId, scope });
  }

  if (workspace.createdBy === actorSub) {
    return allowed(WORKSPACE_AUTH_REASON.ALLOWED_OWNER, {
      actorId: actorSub,
      workspaceId,
      scope,
      workspace,
    });
  }

  const roles = roleResolver ? await roleResolver(actor, workspace, scope) : normalizeRoles(actor);
  const hasAdminRole = allowAdmin && adminRoles.some((role) => roles.includes(role));
  if (hasAdminRole) {
    return allowed(WORKSPACE_AUTH_REASON.ALLOWED_ADMIN, {
      actorId: actorSub,
      workspaceId,
      scope,
      workspace,
    });
  }

  return denied(WORKSPACE_AUTH_REASON.NOT_WORKSPACE_OWNER, {
    actorId: actorSub,
    workspaceId,
    scope,
  });
}

const RESOURCE_QUERIES = Object.freeze({
  draft: {
    table: "draft",
    select: { id: true, clientId: true },
  },
  mediaAsset: {
    table: "mediaAsset",
    select: { id: true, clientId: true },
  },
  property: {
    table: "workspaceDataItem",
    select: { id: true, clientId: true, type: true },
    predicate: (row) => row.type === "PROPERTY",
  },
});

export async function canAccessWorkspaceResource({
  workspaceId,
  resourceType,
  resourceId,
  prismaClient = prisma,
} = {}) {
  const query = RESOURCE_QUERIES[resourceType];
  if (!workspaceId || !query || !resourceId) {
    return denied(WORKSPACE_AUTH_REASON.RESOURCE_NOT_FOUND, {
      workspaceId,
      resourceType,
      resourceId,
    });
  }

  const row = await prismaClient[query.table].findUnique({
    where: { id: resourceId },
    select: query.select,
  });
  if (!row || (query.predicate && !query.predicate(row))) {
    return denied(WORKSPACE_AUTH_REASON.RESOURCE_NOT_FOUND, {
      workspaceId,
      resourceType,
      resourceId,
    });
  }
  if (row.clientId !== workspaceId) {
    return denied(WORKSPACE_AUTH_REASON.RESOURCE_WORKSPACE_MISMATCH, {
      workspaceId,
      resourceType,
      resourceId,
      resourceWorkspaceId: row.clientId,
    });
  }
  return allowed(WORKSPACE_AUTH_REASON.ALLOWED_OWNER, {
    workspaceId,
    resourceType,
    resourceId,
    resource: row,
  });
}

export async function assertCanActorPerformWorkspaceScope(args) {
  const decision = await canActorPerformWorkspaceScope(args);
  if (decision.allowed) return decision;
  const err = new Error("Actor is not authorized for workspace scope");
  err.code = decision.reason;
  err.status = decision.reason === WORKSPACE_AUTH_REASON.WORKSPACE_NOT_FOUND ? 404 : 403;
  err.authorization = decision;
  throw err;
}
