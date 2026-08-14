import { prisma } from "../../prisma.js";

export async function submitFeedback({ input, user, auth0Sub }) {
  let workspace = null;
  if (input.clientId) {
    workspace = await prisma.client.findFirst({ where: { id: input.clientId, createdBy: auth0Sub }, select: { id: true, name: true } });
    if (!workspace) throw Object.assign(new Error("Workspace not found"), { status: 404, code: "NOT_FOUND" });
  }
  const existing = await prisma.betaFeedback.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.userId !== user.id) throw Object.assign(new Error("Feedback request conflict"), { status: 409, code: "FEEDBACK_CONFLICT" });
    return { feedback: existing, duplicate: true };
  }
  const metadata = input.viewport ? { viewport: input.viewport } : undefined;
  const feedback = await prisma.betaFeedback.create({ data: {
    userId: user.id, workspaceId: workspace?.id || null, type: input.type, severity: "normal",
    title: input.message.slice(0, 120), body: input.message, route: input.route,
    status: "new", submitterEmail: user.email, submitterName: user.name,
    workspaceName: workspace?.name || null, releaseVersion: input.releaseVersion,
    deviceClass: input.deviceClass, idempotencyKey: input.idempotencyKey, metadata,
  } });
  return { feedback, duplicate: false };
}

export function listOwnFeedback(userId) {
  return prisma.betaFeedback.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, type: true, body: true, status: true, route: true, createdAt: true, updatedAt: true } });
}

export async function updateAdminFeedback(id, input, actor) {
  const data = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.priority !== undefined) data.severity = input.priority;
  if (input.adminNote !== undefined) data.internalNotes = input.adminNote;
  if (["resolved", "closed"].includes(input.status)) { data.resolvedAt = new Date(); data.resolvedBy = actor; }
  else if (input.status) { data.resolvedAt = null; data.resolvedBy = null; }
  return prisma.betaFeedback.update({ where: { id }, data });
}
