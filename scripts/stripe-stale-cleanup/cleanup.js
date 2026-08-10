import { createHash } from "node:crypto";

export function opaqueRef(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function sameInstant(left, right) {
  return new Date(left).getTime() === new Date(right).getTime();
}

export function assertExpectedState(row, expected) {
  if (!row || opaqueRef(row.userId) !== expected.ref)
    throw new Error("opaque identity mismatch");
  if (row.tier !== expected.tier || row.status !== "ACTIVE")
    throw new Error("billing state changed");
  if (!sameInstant(row.updatedAt, expected.updatedAt))
    throw new Error("billing row changed since investigation");
  if (
    row.stripeCustomerId !== expected.stripeCustomerId ||
    row.stripeSubscriptionId !== expected.stripeSubscriptionId ||
    row.lastStripeEventId !== expected.lastStripeEventId ||
    row.lastStripeEventCreated !== expected.lastStripeEventCreated
  ) {
    throw new Error("Stripe references changed since investigation");
  }
}

export async function guardedDelete({
  db,
  stripeState,
  row,
  expected,
  agencyIntent = "ambiguous",
}) {
  assertExpectedState(row, expected);
  if (expected.tier === "AGENCY" && agencyIntent !== "confirmed_stale") {
    return { deleted: false, reason: "AGENCY_INTENT_AMBIGUOUS" };
  }
  const stripe = await stripeState(row);
  if (!stripe.referencesAbsent || stripe.alternativeLiveSubscription) {
    throw new Error("valid or changed live Stripe state detected");
  }

  return db.transaction(async (tx) => {
    const current = await tx.findById(row.id);
    assertExpectedState(current, expected);
    const result = await tx.deleteExact({
      id: row.id,
      userId: row.userId,
      tier: expected.tier,
      status: "ACTIVE",
      updatedAt: row.updatedAt,
      stripeCustomerId: expected.stripeCustomerId,
      stripeSubscriptionId: expected.stripeSubscriptionId,
      lastStripeEventId: expected.lastStripeEventId,
      lastStripeEventCreated: expected.lastStripeEventCreated,
    });
    if (result.count !== 1) throw new Error("exact-one-row guard failed");
    return { deleted: true, reason: "STALE_BILLING_REMOVED" };
  });
}
