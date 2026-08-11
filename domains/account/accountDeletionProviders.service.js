import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { getImageStorageService, getVideoStorageService } from "../../services/storage/imageStorage.js";

const RETRY_MS = 24 * 60 * 60 * 1000;

async function deleteAuth0User(subject, fetchImpl = globalThis.fetch) {
  const domain = process.env.AUTH0_MANAGEMENT_DOMAIN ?? process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_DELETION_CLIENT_ID;
  const clientSecret = process.env.AUTH0_DELETION_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) throw Object.assign(new Error("Auth0 deletion credential unavailable"), { code: "AUTH0_DELETION_NOT_CONFIGURED" });
  const tokenResponse = await fetchImpl(`https://${domain}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, audience: `https://${domain}/api/v2/` }) });
  const tokenBody = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenBody.access_token) throw Object.assign(new Error("Auth0 management authentication failed"), { code: "AUTH0_MANAGEMENT_AUTH_FAILED" });
  const response = await fetchImpl(`https://${domain}/api/v2/users/${encodeURIComponent(subject)}`, { method: "DELETE", headers: { authorization: `Bearer ${tokenBody.access_token}` } });
  if (!response.ok && response.status !== 404) throw Object.assign(new Error("Auth0 user deletion failed"), { code: `AUTH0_DELETE_HTTP_${response.status}` });
}

export async function processProviderTask(task, { now = new Date(), prismaClient = prisma, fetchImpl = globalThis.fetch } = {}) {
  if (task.status === "COMPLETED") return task;
  try {
    const target = decryptToken(task.targetEncrypted);
    if (task.provider === "CLOUDINARY") {
      const storage = task.resourceType === "video" ? getVideoStorageService() : getImageStorageService();
      const deleted = await storage.delete(target);
      if (!deleted) throw Object.assign(new Error("Cloudinary deletion was not confirmed"), { code: "CLOUDINARY_DELETE_UNCONFIRMED" });
    } else if (task.provider === "AUTH0") await deleteAuth0User(target, fetchImpl);
    else throw Object.assign(new Error("Unsupported deletion provider"), { code: "PROVIDER_UNSUPPORTED" });
    return prismaClient.accountDeletionProviderTask.update({ where: { id: task.id }, data: { status: "COMPLETED", completedAt: now, attemptCount: { increment: 1 }, lastErrorCode: null } });
  } catch (error) {
    return prismaClient.accountDeletionProviderTask.update({ where: { id: task.id }, data: { status: "RETRY", attemptCount: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + RETRY_MS), lastErrorCode: error.code ?? "PROVIDER_DELETE_FAILED" } });
  }
}

export async function runAccountLifecycleMaintenance({ now = new Date(), prismaClient = prisma, fetchImpl = globalThis.fetch } = {}) {
  const { runDueDeletionPurges } = await import("./accountLifecycle.service.js");
  const purges = await runDueDeletionPurges({ now, prismaClient });
  const tasks = await prismaClient.accountDeletionProviderTask.findMany({ where: { status: { in: ["PENDING", "RETRY"] }, nextAttemptAt: { lte: now } }, orderBy: { createdAt: "asc" }, take: 100 });
  for (const task of tasks) await processProviderTask(task, { now, prismaClient, fetchImpl });
  const requests = [...new Set(tasks.map(task => task.requestId))];
  for (const requestId of requests) {
    const remaining = await prismaClient.accountDeletionProviderTask.count({ where: { requestId, status: { not: "COMPLETED" } } });
    if (!remaining) await prismaClient.accountLifecycleRequest.update({ where: { id: requestId }, data: { status: "COMPLETED", completedAt: now, failureCode: null } });
  }
  await prismaClient.accountLifecycleRequest.deleteMany({ where: { type: "EXPORT_ACCOUNT", exportExpiresAt: { lt: now } } });
  const overdueTasks = await prismaClient.accountDeletionProviderTask.findMany({ where: { status: { not: "COMPLETED" }, createdAt: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } }, select: { requestId: true } });
  for (const requestId of new Set(overdueTasks.map(task => task.requestId))) {
    await prismaClient.accountLifecycleRequest.update({ where: { id: requestId }, data: { failureCode: "PROVIDER_CLEANUP_OVERDUE" } });
  }
  await prismaClient.aiRunTrace.deleteMany({ where: { retentionUntil: { lt: now } } });
  await prismaClient.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000) } } });
  const expiredTombstones = await prismaClient.accountLifecycleRequest.findMany({ where: { type: "DELETE_ACCOUNT", tombstoneUntil: { lt: now }, status: "COMPLETED" }, select: { id: true, userId: true } });
  for (const tombstone of expiredTombstones) await prismaClient.$transaction(async tx => {
    await tx.subscription.deleteMany({ where: { userId: tombstone.userId } });
    await tx.accountLifecycleRequest.delete({ where: { id: tombstone.id } });
    await tx.user.deleteMany({ where: { id: tombstone.userId, auth0Sub: { startsWith: "deleted-" } } });
  });
  return { purges: purges.length, providerTasks: tasks.length, expiredTombstones: expiredTombstones.length };
}
