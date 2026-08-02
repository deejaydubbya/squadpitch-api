import { prisma } from "../../prisma.js";

const DAY_MS = 86_400_000;
export const RETENTION_BATCH_SIZE = 100;

export function retentionCutoff(now, days) {
  if (!Number.isInteger(days) || days <= 0) return null;
  return new Date(now.getTime() - days * DAY_MS);
}

export async function enforceWorkspaceContactRetention({
  clientId,
  retentionDays,
  now = new Date(),
  dryRun = false,
  batchSize = RETENTION_BATCH_SIZE,
}) {
  const cutoff = retentionCutoff(now, retentionDays);
  if (!cutoff) return { clientId, disabled: true, dryRun, examined: 0, deleted: 0 };

  const candidates = await prisma.contact.findMany({
    where: {
      clientId,
      updatedAt: { lt: cutoff },
      conversations: { none: { updatedAt: { gte: cutoff } } },
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(batchSize, RETENTION_BATCH_SIZE)),
    select: {
      id: true,
      conversations: {
        where: { sourceFormSubmissionId: { not: null } },
        select: { sourceFormSubmissionId: true },
      },
    },
  });

  if (dryRun || candidates.length === 0) {
    return {
      clientId,
      disabled: false,
      dryRun,
      cutoff: cutoff.toISOString(),
      examined: candidates.length,
      deleted: 0,
    };
  }

  const ids = candidates.map(({ id }) => id);
  const submissionIds = candidates.flatMap(({ conversations }) =>
    conversations.map(({ sourceFormSubmissionId }) => sourceFormSubmissionId).filter(Boolean),
  );
  await prisma.$transaction(async (tx) => {
    await tx.contact.deleteMany({ where: { clientId, id: { in: ids } } });
    if (submissionIds.length) {
      await tx.formSubmission.deleteMany({
        where: { clientId, id: { in: submissionIds } },
      });
    }
    await tx.auditLog.create({
      data: {
        actorSub: "system:contact-retention",
        actorRoles: ["SYSTEM"],
        action: "inbox.contact.retention_purge",
        resourceType: "Client",
        resourceId: clientId,
        metadata: {
          retentionDays,
          cutoff: cutoff.toISOString(),
          contactsDeleted: ids.length,
          submissionsDeleted: submissionIds.length,
        },
      },
    });
  });
  return {
    clientId,
    disabled: false,
    dryRun: false,
    cutoff: cutoff.toISOString(),
    examined: candidates.length,
    deleted: ids.length,
    submissionsDeleted: submissionIds.length,
  };
}

export async function runContactRetention({ now = new Date(), dryRun = false } = {}) {
  const workspaces = await prisma.client.findMany({
    where: { status: "ACTIVE", contactRetentionDays: { gt: 0 } },
    orderBy: { id: "asc" },
    select: { id: true, contactRetentionDays: true },
  });
  const results = [];
  for (const workspace of workspaces) {
    let result;
    do {
      result = await enforceWorkspaceContactRetention({
        clientId: workspace.id,
        retentionDays: workspace.contactRetentionDays,
        now,
        dryRun,
      });
      results.push(result);
    } while (!dryRun && result.examined === RETENTION_BATCH_SIZE);
  }
  return {
    dryRun,
    workspaces: workspaces.length,
    contactsDeleted: results.reduce((sum, result) => sum + result.deleted, 0),
    batches: results.length,
    results,
  };
}
