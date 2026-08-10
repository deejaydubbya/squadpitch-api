import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import { prisma } from "../../prisma.js";
import { STRIPE_API_VERSION } from "../../domains/billing/stripeSafety.js";
import { guardedDelete, opaqueRef } from "./cleanup.js";
import { dbAdapter, EXPECTED, liveBillingState } from "./index.js";

const TARGET_REF = "3a3074731701";

export async function runConfirmedAgencyCleanup({
  restrictedKey = process.env.STRIPE_DR_RESTRICTED_KEY,
} = {}) {
  if (!restrictedKey?.startsWith("rk_live_"))
    throw new Error("restricted live key required");
  delete process.env.STRIPE_SECRET_KEY;
  const stripe = new Stripe(restrictedKey, { apiVersion: STRIPE_API_VERSION });
  const beforeCount = await prisma.subscription.count();
  const candidates = await prisma.subscription.findMany();
  const row = candidates.find(
    (candidate) => opaqueRef(candidate.userId) === TARGET_REF,
  );
  if (!row) throw new Error("Agency target not found");
  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { email: true },
  });
  if (!user) throw new Error("Agency owner not found");
  const known = EXPECTED[TARGET_REF];
  const expected = {
    ref: TARGET_REF,
    tier: known.tier,
    updatedAt: known.updatedAt,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    lastStripeEventId: row.lastStripeEventId,
    lastStripeEventCreated: known.lastStripeEventCreated,
  };
  const result = await guardedDelete({
    db: dbAdapter(),
    row,
    expected,
    agencyIntent: "confirmed_stale",
    stripeState: async () => liveBillingState(stripe, row, user.email),
  });
  const after = await prisma.subscription.findMany({
    select: { userId: true },
  });
  if (after.some((candidate) => opaqueRef(candidate.userId) === TARGET_REF)) {
    throw new Error("Agency target remains after cleanup");
  }
  if (after.length !== beforeCount - 1)
    throw new Error("unrelated row-count invariant failed");
  return {
    agencyPreflightPassed: true,
    agencyDeleted: result.deleted,
    rowsAffected: result.deleted ? 1 : 0,
    checkoutBlockerRemaining: false,
    incorrectEntitlementRemaining: false,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runConfirmedAgencyCleanup(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: "AGENCY_CLEANUP_ABORTED",
        reason: error.message,
      }),
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
