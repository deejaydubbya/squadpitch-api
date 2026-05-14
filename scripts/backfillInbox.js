// Backfill SquadInbox from existing FormSubmissions.
//
// Walks every FormSubmission with a non-null contactEmail OR
// contactPhone and runs the intake service. Idempotent — the
// intake service short-circuits when a Conversation already
// exists for that submission, so re-running is safe.
//
// Usage:
//   node scripts/backfillInbox.js [--client=<clientId>] [--dry-run]
//
// Production:
//   flyctl machine exec <machine-id> -a squadpitch-api \
//     'sh -c "cd /app && node scripts/backfillInbox.js"'

import { PrismaClient } from "@prisma/client";
import { intakeFormSubmission } from "../domains/inbox/inbox.intake.service.js";

const prisma = new PrismaClient();

function parseArgs() {
  const args = { dryRun: false, clientId: null };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    const match = /^--([a-z]+)=(.+)$/i.exec(a);
    if (match) args[match[1].toLowerCase()] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  console.log(
    `[backfillInbox] starting ${args.dryRun ? "(DRY RUN)" : ""} clientFilter=${args.clientid ?? "all"}`,
  );

  const where = {
    OR: [{ contactEmail: { not: null } }, { contactPhone: { not: null } }],
  };
  if (args.clientid) where.clientId = args.clientid;

  // Stream in batches so a workspace with thousands of historical
  // submissions doesn't blow the heap.
  const batchSize = 200;
  let cursor;
  const totals = {
    seen: 0,
    created: 0,
    alreadyProcessed: 0,
    skipped: 0,
    errored: 0,
  };

  while (true) {
    const batch = await prisma.formSubmission.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const submission of batch) {
      totals.seen += 1;
      if (args.dryRun) {
        console.log(`[backfillInbox] would intake submission=${submission.id}`);
        continue;
      }
      try {
        const result = await intakeFormSubmission(submission);
        if (result.status === "created") totals.created += 1;
        else if (result.status === "already_processed")
          totals.alreadyProcessed += 1;
        else totals.skipped += 1;
        if (result.status === "skipped") {
          console.log(
            `[backfillInbox] skipped submission=${submission.id} reason=${result.reason}`,
          );
        }
      } catch (err) {
        totals.errored += 1;
        console.error(
          `[backfillInbox] error on submission=${submission.id}:`,
          err?.message ?? err,
        );
      }
    }

    console.log(
      `[backfillInbox] processed batch — seen=${totals.seen} created=${totals.created} skipped=${totals.skipped} errored=${totals.errored}`,
    );
  }

  console.log(
    `[backfillInbox] done — seen=${totals.seen} created=${totals.created} alreadyProcessed=${totals.alreadyProcessed} skipped=${totals.skipped} errored=${totals.errored}`,
  );
}

main()
  .catch((err) => {
    console.error("[backfillInbox] fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
