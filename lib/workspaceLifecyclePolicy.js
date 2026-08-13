import { prisma } from "../prisma.js";

export function assertWorkspaceAllowsExternalSideEffects(workspace, operation = "external action") {
  if (!workspace) throw Object.assign(new Error("Workspace not found"), { status: 404, code: "WORKSPACE_NOT_FOUND" });
  if (workspace.lifecycle === "PROSPECT") throw Object.assign(new Error(`Prospect workspaces cannot perform ${operation} before claim`), { status: 409, code: "PROSPECT_SIDE_EFFECT_BLOCKED" });
  return workspace;
}

export async function assertClientAllowsExternalSideEffects(clientId, operation) {
  const workspace = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, lifecycle: true } });
  return assertWorkspaceAllowsExternalSideEffects(workspace, operation);
}
