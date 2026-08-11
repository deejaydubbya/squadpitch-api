import { createHash } from "node:crypto";
import { prisma } from "../../prisma.js";
import { encryptToken } from "../../lib/tokenCrypto.js";

export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const FINANCIAL_RETENTION_MS = 7 * 365 * 24 * 60 * 60 * 1000;
const OPEN_STATUSES = ["PENDING", "VERIFIED", "PROCESSING", "GRACE_PERIOD", "PURGING", "PARTIAL_PROVIDER_FAILURE"];
const hash = value => createHash("sha256").update(String(value)).digest("hex");

export async function requestAccountLifecycle({ user, auth0Sub, type, now = new Date(), prismaClient = prisma }) {
  const existing = await prismaClient.accountLifecycleRequest.findFirst({
    where: { userId: user.id, type, status: { in: OPEN_STATUSES } }, orderBy: { requestedAt: "desc" },
  });
  if (existing) return { request: existing, created: false };

  return prismaClient.$transaction(async tx => {
    const deletion = type === "DELETE_ACCOUNT";
    const workspaces = deletion ? await tx.client.findMany({
      where: { createdBy: auth0Sub, status: { not: "ARCHIVED" } },
      select: { id: true, status: true, site: { select: { status: true } }, drafts: { where: { status: "SCHEDULED" }, select: { id: true } } },
    }) : [];
    const request = await tx.accountLifecycleRequest.create({
      data: {
        userId: user.id, auth0Sub, emailSnapshot: user.email, type,
        status: deletion ? "GRACE_PERIOD" : "PENDING",
        graceEndsAt: deletion ? new Date(now.getTime() + DELETION_GRACE_MS) : null,
        exportExpiresAt: deletion ? null : new Date(now.getTime() + DELETION_GRACE_MS),
        workspaceSnapshot: deletion ? workspaces.map(workspace => ({ id: workspace.id, status: workspace.status, siteStatus: workspace.site?.status ?? null, scheduledDraftIds: workspace.drafts?.map(draft => draft.id) ?? [] })) : undefined,
      },
    });
    if (deletion) {
      const workspaceIds = workspaces.map(({ id }) => id);
      if (workspaceIds.length) {
        await tx.client.updateMany({ where: { id: { in: workspaceIds }, createdBy: auth0Sub }, data: { status: "ARCHIVED" } });
        await tx.draft.updateMany({ where: { clientId: { in: workspaceIds }, status: "SCHEDULED" }, data: { status: "FAILED", publishError: "Account deletion requested; publishing disabled." } });
        await tx.site.updateMany({ where: { clientId: { in: workspaceIds } }, data: { status: "ARCHIVED" } });
        await tx.channelConnection.deleteMany({ where: { clientId: { in: workspaceIds } } });
        await tx.workspaceTechStackConnection.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      }
      await tx.integration.deleteMany({ where: { userId: user.id } });
      await tx.slackConnection.deleteMany({ where: { userId: user.id } });
      await tx.outboundWebhook.deleteMany({ where: { userId: user.id } });
    }
    return { request, created: true };
  });
}

export async function cancelDeletion({ requestId, user, now = new Date(), prismaClient = prisma }) {
  return prismaClient.$transaction(async tx => {
    const request = await tx.accountLifecycleRequest.findFirst({ where: { id: requestId, userId: user.id, type: "DELETE_ACCOUNT", status: "GRACE_PERIOD" } });
    if (!request) throw Object.assign(new Error("Active deletion request not found"), { status: 404, code: "DELETION_NOT_CANCELLABLE" });
    if (request.graceEndsAt <= now) throw Object.assign(new Error("Deletion grace period has elapsed"), { status: 409, code: "DELETION_GRACE_ELAPSED" });
    const snapshot = Array.isArray(request.workspaceSnapshot) ? request.workspaceSnapshot : [];
    for (const item of snapshot) {
      await tx.client.updateMany({ where: { id: item.id, createdBy: user.auth0Sub, status: "ARCHIVED" }, data: { status: item.status } });
      if (item.siteStatus) await tx.site.updateMany({ where: { clientId: item.id, status: "ARCHIVED" }, data: { status: item.siteStatus } });
      if (item.scheduledDraftIds?.length) await tx.draft.updateMany({ where: { id: { in: item.scheduledDraftIds }, clientId: item.id, status: "FAILED" }, data: { status: "SCHEDULED", publishError: null } });
    }
    return tx.accountLifecycleRequest.update({ where: { id: request.id }, data: { status: "CANCELLED", cancelledAt: now, completedAt: now } });
  });
}

export async function purgeDeletion({ requestId, now = new Date(), prismaClient = prisma }) {
  return prismaClient.$transaction(async tx => {
    const request = await tx.accountLifecycleRequest.findUnique({ where: { id: requestId }, include: { user: true } });
    if (!request || request.type !== "DELETE_ACCOUNT") throw Object.assign(new Error("Deletion request not found"), { status: 404, code: "DELETION_NOT_FOUND" });
    if (request.status === "COMPLETED" || request.status === "PARTIAL_PROVIDER_FAILURE") return request;
    if (request.status !== "GRACE_PERIOD" || !request.graceEndsAt || request.graceEndsAt > now) throw Object.assign(new Error("Deletion grace period has not elapsed"), { status: 409, code: "DELETION_GRACE_ACTIVE" });
    const workspaceIds = (await tx.client.findMany({ where: { createdBy: request.auth0Sub }, select: { id: true } })).map(row => row.id);
    const assets = workspaceIds.length ? await tx.mediaAsset.findMany({ where: { clientId: { in: workspaceIds }, publicId: { not: null } }, select: { publicId: true, assetType: true } }) : [];
    for (const asset of assets) await tx.accountDeletionProviderTask.upsert({
      where: { requestId_provider_targetHash: { requestId, provider: "CLOUDINARY", targetHash: hash(`${asset.assetType}:${asset.publicId}`) } },
      create: { requestId, provider: "CLOUDINARY", targetEncrypted: encryptToken(asset.publicId), targetHash: hash(`${asset.assetType}:${asset.publicId}`), resourceType: asset.assetType }, update: {},
    });
    await tx.accountDeletionProviderTask.upsert({
      where: { requestId_provider_targetHash: { requestId, provider: "AUTH0", targetHash: hash(request.auth0Sub) } },
      create: { requestId, provider: "AUTH0", targetEncrypted: encryptToken(request.auth0Sub), targetHash: hash(request.auth0Sub), resourceType: "user" }, update: {},
    });
    if (workspaceIds.length) await tx.client.deleteMany({ where: { id: { in: workspaceIds }, createdBy: request.auth0Sub } });
    await Promise.all([
      tx.usageRecord.deleteMany({ where: { userId: request.userId } }), tx.signupPlanIntent.deleteMany({ where: { userId: request.userId } }),
      tx.notificationPreference.deleteMany({ where: { userId: request.userId } }), tx.pushSubscription.deleteMany({ where: { userId: request.userId } }),
      tx.notificationLog.deleteMany({ where: { userId: request.userId } }), tx.notification.deleteMany({ where: { userId: request.userId } }),
      tx.activityEvent.deleteMany({ where: { userId: request.userId } }), tx.aiUsageLog.deleteMany({ where: { userId: request.userId } }),
      tx.integration.deleteMany({ where: { userId: request.userId } }), tx.slackConnection.deleteMany({ where: { userId: request.userId } }), tx.outboundWebhook.deleteMany({ where: { userId: request.userId } }),
    ]);
    const anonymous = `deleted-${hash(request.userId).slice(0, 24)}`;
    await tx.user.update({ where: { id: request.userId }, data: { auth0Sub: anonymous, email: `${anonymous}@deleted.invalid`, name: null, avatarUrl: null } });
    await tx.accountLifecycleRequest.update({ where: { id: request.id }, data: {
      status: "PARTIAL_PROVIDER_FAILURE", lastAttemptAt: now,
      tombstoneUntil: new Date(now.getTime() + FINANCIAL_RETENTION_MS),
      auth0Sub: hash(request.auth0Sub), emailSnapshot: hash(request.emailSnapshot), workspaceSnapshot: null,
    } });
    return request;
  });
}

export async function runDueDeletionPurges({ now = new Date(), prismaClient = prisma }) {
  const due = await prismaClient.accountLifecycleRequest.findMany({ where: { type: "DELETE_ACCOUNT", status: "GRACE_PERIOD", graceEndsAt: { lte: now } }, select: { id: true } });
  const results = [];
  for (const { id } of due) {
    try { await purgeDeletion({ requestId: id, now, prismaClient }); results.push({ id, status: "PURGED" }); }
    catch (error) { await prismaClient.accountLifecycleRequest.update({ where: { id }, data: { failureCode: error.code ?? "PURGE_FAILED", failureCount: { increment: 1 }, lastAttemptAt: now } }); results.push({ id, status: "FAILED" }); }
  }
  return results;
}
