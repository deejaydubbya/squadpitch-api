import { prisma } from "../prisma.js";
import { getDiscoveryProvider } from "../domains/prospects/discovery/providers.js";

const execute = process.argv.includes("--execute");
const normalizeEmail = (value) => String(value || "").trim().toLowerCase() || null;

const workspaces = await prisma.prospectWorkspace.findMany({
  where: { client: { lifecycle: "PROSPECT" } },
  include: {
    client: { select: { id: true, name: true, lifecycle: true } },
    outreachProspect: { select: { id: true, status: true } },
  },
  orderBy: { createdAt: "asc" },
});

const report = [];
for (const workspace of workspaces) {
  const email = normalizeEmail(workspace.prospectEmail);
  let identity = { provider: null, providerExternalId: null, normalizedProfileUrl: null };
  if (workspace.websiteUrl) {
    try {
      const provider = getDiscoveryProvider(workspace.websiteUrl);
      if (provider?.classify(workspace.websiteUrl, "") === "AGENT_PROFILE") identity = provider.identity(workspace.websiteUrl);
    } catch {}
  }
  const matches = [
    ...(email ? [{ normalizedEmail: email }] : []),
    ...(identity.provider && identity.providerExternalId ? [{ provider_providerExternalId: { provider: identity.provider, providerExternalId: identity.providerExternalId } }] : []),
    ...(identity.normalizedProfileUrl ? [{ stableIdentity: identity.normalizedProfileUrl }] : []),
  ];
  let existing = workspace.outreachProspect;
  if (!existing) for (const where of matches) { existing = await prisma.agentOutreachProspect.findUnique({ where, select: { id: true, status: true, prospectWorkspaceId: true, emailSentAt: true, claimedAt: true } }); if (existing) break; }
  const reusableMatch = Boolean(existing && !existing.prospectWorkspaceId && !existing.emailSentAt && !existing.claimedAt && ["DISCOVERED", "QUALIFIED", "PREVIEW_PENDING", "PREVIEW_FAILED", "NO_EMAIL", "INVALID_EMAIL", "NO_ACTIVE_LISTINGS", "SCRAPE_ERROR"].includes(existing.status));
  report.push({ workspaceId: workspace.id, clientId: workspace.clientId, name: workspace.prospectName, email, claimStatus: workspace.claimStatus, claimedAt: workspace.claimedAt, createdAt: workspace.createdAt, alreadyLinked: Boolean(workspace.outreachProspect), matchingOutreachId: existing?.id || null, matchingOutreachStatus: existing?.status || null, reusableMatch, identity });
}

const unlinked = report.filter((row) => !row.alreadyLinked);
const conflicts = unlinked.filter((row) => row.matchingOutreachId && !row.reusableMatch);
console.log(JSON.stringify({ execute, counts: { eligibleProspectWorkspaces: report.length, alreadyLinked: report.length - unlinked.length, unlinked: unlinked.length, claimed: report.filter((row) => row.claimStatus === "CLAIMED").length, unclaimed: report.filter((row) => row.claimStatus !== "CLAIMED").length, reusableMatches: unlinked.filter((row) => row.reusableMatch).length, unsafeIdentityConflicts: conflicts.length }, workspaces: report }, null, 2));

if (execute) {
  if (conflicts.length) throw new Error("Unsafe identity conflicts require manual review; refusing automatic backfill");
  const created = [], reused = [];
  for (const row of unlinked) {
    const workspace = workspaces.find((item) => item.id === row.workspaceId);
    const status = workspace.claimStatus === "CLAIMED" ? "CLAIMED" : "MANUAL_OUTREACH";
    if (row.reusableMatch) {
      await prisma.agentOutreachProspect.update({ where: { id: row.matchingOutreachId }, data: { prospectWorkspaceId: workspace.id, status, claimedAt: workspace.claimedAt, rejectionReason: status === "MANUAL_OUTREACH" ? "Manual outreach / send details unavailable" : null, events: { create: { type: status === "CLAIMED" ? "legacy_claimed" : "legacy_manual_outreach", message: status === "CLAIMED" ? "Linked to an already-claimed legacy prospect workspace" : "Linked to legacy workspace; manual outreach / send details unavailable" } } } });
      reused.push(row.matchingOutreachId);
      continue;
    }
    const outreach = await prisma.agentOutreachProspect.create({ data: {
      prospectWorkspaceId: workspace.id,
      normalizedEmail: row.email,
      email: row.email,
      fullName: workspace.prospectName,
      profileUrl: row.identity.normalizedProfileUrl || workspace.websiteUrl,
      sourceUrl: workspace.sourceUrl || workspace.websiteUrl || "legacy://prospect-workspace",
      sourceDomain: (() => { try { return new URL(workspace.websiteUrl || workspace.sourceUrl).hostname.toLowerCase(); } catch { return "legacy"; } })(),
      provider: row.identity.provider,
      providerExternalId: row.identity.providerExternalId,
      stableIdentity: row.identity.normalizedProfileUrl,
      status,
      rejectionReason: status === "MANUAL_OUTREACH" ? "Manual outreach / send details unavailable" : null,
      listings: [],
      activeListingCount: 0,
      emailSentAt: null,
      claimedAt: workspace.claimedAt,
      events: { create: { type: status === "CLAIMED" ? "legacy_claimed" : "legacy_manual_outreach", message: status === "CLAIMED" ? "Legacy prospect workspace was already claimed" : "Manual outreach / send details unavailable" } },
    } });
    created.push(outreach.id);
  }
  console.log(JSON.stringify({ result: { created: created.length, reused: reused.length, createdOutreachIds: created, reusedOutreachIds: reused, workspacesDuplicated: 0, tokensRegenerated: 0 } }, null, 2));
}

await prisma.$disconnect();
