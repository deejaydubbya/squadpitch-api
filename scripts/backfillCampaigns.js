// Backfill script: create Campaign rows for every existing
// distinct (clientId, campaignId) in the drafts table.
//
// Safe to run multiple times. The script skips groups that
// already have a Campaign row, so it can be re-run after the new
// Phase-3 save-drafts logic starts creating cuid-based Campaign
// rows alongside the legacy `camp_<ts>_<rand>` ids.
//
// Usage:
//   node scripts/backfillCampaigns.js               # apply
//   node scripts/backfillCampaigns.js --dry-run     # report only
//
// Production usage:
//   flyctl ssh console -a squadpitch-api -C \
//     "node scripts/backfillCampaigns.js --dry-run"
//   # review output, then re-run without --dry-run

import { PrismaClient } from "@prisma/client";
import { parseDraftSourceMeta, sourceTitleForDisplay } from "../domains/studio/draftSourceMeta.server.js";
import { inferStatusFromDraftStatuses } from "../domains/studio/campaign.service.js";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const startedAt = Date.now();
  console.log(`[backfillCampaigns] starting ${DRY_RUN ? "(dry-run)" : "(write mode)"}`);

  // Distinct (clientId, campaignId) groups from drafts where
  // campaignId is set. groupBy on the two columns is the cheapest
  // path — we then fetch the canonical first-draft + aggregates
  // per group.
  const groups = await prisma.draft.groupBy({
    by: ["clientId", "campaignId"],
    where: { campaignId: { not: null } },
  });
  console.log(`[backfillCampaigns] found ${groups.length} draft groups`);

  let inserted = 0;
  let skipped = 0;
  let errored = 0;
  const errors = [];

  for (const { clientId, campaignId } of groups) {
    try {
      // Idempotency: skip if Campaign row already exists.
      const existing = await prisma.campaign.findUnique({
        where: { id: campaignId },
      });
      if (existing) {
        skipped += 1;
        continue;
      }

      // Canonical first draft for name / type / createdBy /
      // createdAt. campaignOrder asc, then earliest createdAt as
      // tiebreaker.
      const firstDraft = await prisma.draft.findFirst({
        where: { clientId, campaignId },
        orderBy: [{ campaignOrder: "asc" }, { createdAt: "asc" }],
      });
      if (!firstDraft) {
        // Race or stale group — shouldn't happen but skip
        // gracefully.
        skipped += 1;
        continue;
      }

      // Source meta from the first draft's warnings.
      const meta = parseDraftSourceMeta(firstDraft.warnings);

      // Schedule envelope from the actual scheduledFor values on
      // the drafts that belong to this group. We don't fall back
      // to scheduleAnchor because (per the user clarification)
      // the canonical timeline is the drafts' real schedule.
      const dates = await prisma.draft.aggregate({
        where: { clientId, campaignId, scheduledFor: { not: null } },
        _min: { scheduledFor: true },
        _max: { scheduledFor: true },
      });

      // Status rollup. Fetch just the status column (cheap) and
      // pass to the shared helper.
      const statusRows = await prisma.draft.findMany({
        where: { clientId, campaignId },
        select: { status: true },
      });
      const status = inferStatusFromDraftStatuses(statusRows);

      const data = {
        id: campaignId,
        clientId,
        name: firstDraft.campaignName ?? "Unnamed Campaign",
        campaignType: firstDraft.campaignType ?? meta.campaignType ?? "just_listed",
        sourceType: meta.sourceType,
        sourceDataItemId: meta.dataItemId,
        sourceTitle: sourceTitleForDisplay(meta),
        campaignIdea: meta.campaignIdea,
        status,
        startsAt: dates._min.scheduledFor,
        endsAt: dates._max.scheduledFor,
        // createdBy is nullable in the model — if we don't have a
        // value, write null rather than failing.
        createdBy: firstDraft.createdBy || null,
        // Anchor createdAt to the earliest draft in the group so
        // sort-by-created in admin views reflects original
        // campaign creation time.
        createdAt: firstDraft.createdAt,
      };

      if (DRY_RUN) {
        console.log(
          `[backfillCampaigns] DRY would insert id=${campaignId} client=${clientId} status=${status} drafts=${statusRows.length}`,
        );
        inserted += 1;
        continue;
      }

      await prisma.campaign.create({ data });
      inserted += 1;
    } catch (err) {
      errored += 1;
      errors.push({
        campaignId,
        clientId,
        message: err?.message ?? String(err),
      });
      console.error(
        `[backfillCampaigns] FAILED id=${campaignId} client=${clientId}: ${err?.message}`,
      );
      // Continue — one bad row shouldn't fail the whole pass.
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[backfillCampaigns] done in ${durationMs}ms — groups=${groups.length} inserted=${inserted} skipped=${skipped} errored=${errored}`,
  );

  if (errors.length > 0) {
    console.log(`[backfillCampaigns] errors:`);
    for (const e of errors) {
      console.log(`  - ${e.clientId}/${e.campaignId}: ${e.message}`);
    }
  }
}

main()
  .catch((err) => {
    console.error("[backfillCampaigns] fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
