import { prisma } from "../prisma.js";

const execute = process.argv.includes("--execute");
const runs = await prisma.agentDiscoveryRun.findMany({
  where: { status: "RUNNING" },
  include: {
    prospects: {
      select: {
        id: true,
        status: true,
        prospectWorkspaceId: true,
        emailSentAt: true,
        claimedAt: true,
        discoveredAt: true,
        _count: { select: { events: true } },
      },
    },
  },
  orderBy: { createdAt: "desc" },
});

const safeStatuses = new Set(["DISCOVERED", "QUALIFIED", "NO_EMAIL", "INVALID_EMAIL", "NO_ACTIVE_LISTINGS", "DUPLICATE", "SUPPRESSED", "SCRAPE_ERROR"]);
const report = runs.map((run) => ({
  id: run.id,
  sourceUrl: run.sourceUrl,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  pagesScanned: run.pagesScanned,
  metrics: {
    agentLinksFound: run.agentLinksFound,
    newAgentsCount: run.newAgentsCount,
    qualifiedCount: run.qualifiedCount,
    rejectedCount: run.rejectedCount,
    duplicateCount: run.duplicateCount,
    suppressedCount: run.suppressedCount,
    errorCount: run.errorCount,
  },
  prospectCount: run.prospects.length,
  deletableProspectIds: run.prospects.filter((row) => safeStatuses.has(row.status) && !row.prospectWorkspaceId && !row.emailSentAt && !row.claimedAt).map((row) => row.id),
  protectedProspects: run.prospects.filter((row) => !safeStatuses.has(row.status) || row.prospectWorkspaceId || row.emailSentAt || row.claimedAt).map((row) => ({ id: row.id, status: row.status })),
}));

console.log(JSON.stringify({ execute, runningRuns: report }, null, 2));

if (execute) {
  if (runs.length !== 1) throw new Error(`Expected exactly one RUNNING discovery run; found ${runs.length}`);
  const target = report[0];
  if (target.protectedProspects.length) throw new Error("The RUNNING run contains protected outreach records; refusing cleanup");
  const result = await prisma.$transaction(async (tx) => {
    const stopped = await tx.agentDiscoveryRun.updateMany({ where: { id: target.id, status: "RUNNING" }, data: { status: "STOPPED", completedAt: new Date(), lastError: "Stopped for operator-requested clean reset" } });
    if (stopped.count !== 1) throw new Error("Run status changed before cleanup; refusing deletion");
    const deleted = await tx.agentOutreachProspect.deleteMany({ where: { id: { in: target.deletableProspectIds }, discoveryRunId: target.id, prospectWorkspaceId: null, emailSentAt: null, claimedAt: null, status: { in: [...safeStatuses] } } });
    return { runId: target.id, stopped: stopped.count, deletedProspects: deleted.count };
  });
  console.log(JSON.stringify({ result }, null, 2));
}

await prisma.$disconnect();
