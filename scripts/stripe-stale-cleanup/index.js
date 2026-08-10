import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import { prisma } from "../../prisma.js";
import { STRIPE_API_VERSION } from "../../domains/billing/stripeSafety.js";
import { assertExpectedState, guardedDelete, opaqueRef } from "./cleanup.js";

const EXPECTED = {
  a8ec8e2ff400: {
    tier: "PRO",
    updatedAt: new Date("2026-07-04T17:31:39.165Z"),
    lastStripeEventCreated: 1783186298,
  },
  "3a3074731701": {
    tier: "AGENCY",
    updatedAt: new Date("2026-07-30T20:07:10.875Z"),
    lastStripeEventCreated: 1785442030,
  },
};

async function retrieveState(call) {
  try {
    const value = await call();
    return Boolean(value && !value.deleted);
  } catch (error) {
    if (error?.code === "resource_missing") return false;
    throw error;
  }
}

async function liveBillingState(stripe, row, email) {
  const metadataQuery = `metadata['userId']:'${row.userId.replaceAll("'", "\\'")}'`;
  const [
    customerExists,
    subscriptionExists,
    ownedCustomers,
    ownedSubscriptions,
    emailCustomers,
  ] = await Promise.all([
    retrieveState(() => stripe.customers.retrieve(row.stripeCustomerId)),
    retrieveState(() =>
      stripe.subscriptions.retrieve(row.stripeSubscriptionId),
    ),
    stripe.customers.search({ query: metadataQuery, limit: 100 }),
    stripe.subscriptions.search({ query: metadataQuery, limit: 100 }),
    stripe.customers.list({ email, limit: 100 }),
  ]);
  const alternatives = new Map();
  for (const customer of [...ownedCustomers.data, ...emailCustomers.data]) {
    if (!customer.deleted && customer.id !== row.stripeCustomerId)
      alternatives.set(customer.id, customer);
  }
  let alternativeBillable = ownedSubscriptions.data.some(
    (subscription) =>
      subscription.id !== row.stripeSubscriptionId &&
      ["active", "trialing", "past_due", "unpaid"].includes(
        subscription.status,
      ),
  );
  for (const customer of alternatives.values()) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 100,
    });
    if (
      subscriptions.data.some((subscription) =>
        ["active", "trialing", "past_due", "unpaid"].includes(
          subscription.status,
        ),
      )
    ) {
      alternativeBillable = true;
    }
  }
  return {
    referencesAbsent: !customerExists && !subscriptionExists,
    alternativeLiveSubscription: alternativeBillable,
  };
}

function dbAdapter() {
  return {
    transaction: (operation) =>
      prisma.$transaction((tx) =>
        operation({
          findById: (id) => tx.subscription.findUnique({ where: { id } }),
          deleteExact: (where) => tx.subscription.deleteMany({ where }),
        }),
      ),
  };
}

export async function runCleanup({
  restrictedKey = process.env.STRIPE_DR_RESTRICTED_KEY,
} = {}) {
  if (!restrictedKey?.startsWith("rk_live_"))
    throw new Error("restricted live key required");
  delete process.env.STRIPE_SECRET_KEY;
  const stripe = new Stripe(restrictedKey, { apiVersion: STRIPE_API_VERSION });
  const allRows = await prisma.subscription.findMany();
  const rows = Object.fromEntries(
    allRows
      .filter((row) => EXPECTED[opaqueRef(row.userId)])
      .map((row) => [opaqueRef(row.userId), row]),
  );
  if (Object.keys(rows).length !== 2)
    throw new Error("preflight target correlation failed");

  const users = await prisma.user.findMany({
    where: { id: { in: Object.values(rows).map((row) => row.userId) } },
    select: { id: true, auth0Sub: true, email: true },
  });
  const usersById = new Map(users.map((user) => [user.id, user]));
  const preflight = {};
  for (const [ref, row] of Object.entries(rows)) {
    const known = EXPECTED[ref];
    const expected = {
      ref,
      tier: known.tier,
      updatedAt: known.updatedAt,
      stripeCustomerId: row.stripeCustomerId,
      stripeSubscriptionId: row.stripeSubscriptionId,
      lastStripeEventId: row.lastStripeEventId,
      lastStripeEventCreated: known.lastStripeEventCreated,
    };
    const stripeState = await liveBillingState(
      stripe,
      row,
      usersById.get(row.userId).email,
    );
    preflight[ref] = { expected, stripeState };
    assertExpectedState(row, expected);
    if (
      !stripeState.referencesAbsent ||
      stripeState.alternativeLiveSubscription
    ) {
      throw new Error("preflight found live Stripe billing");
    }
  }

  const agencyUser = usersById.get(rows["3a3074731701"].userId);
  const tester = await prisma.betaTester.findFirst({
    where: { userId: { in: [agencyUser.id, agencyUser.auth0Sub] } },
    select: { id: true, tags: true, notes: true, contactNotes: true },
  });
  const intentText = [
    tester?.tags?.join(" "),
    tester?.notes,
    tester?.contactNotes,
  ]
    .filter(Boolean)
    .join(" ");
  const intentionalAgencyEvidence =
    /\b(?:agency|complimentary|internal|grant(?:ed)?|free)\b/i.test(intentText);
  // Agency is an explicitly supported internal tier. Lack of affirmative notes is ambiguous, not permission to delete.
  const agencyIntent = intentionalAgencyEvidence ? "intentional" : "ambiguous";

  const proRef = "a8ec8e2ff400";
  const proRow = rows[proRef];
  const proResult = await guardedDelete({
    db: dbAdapter(),
    row: proRow,
    expected: preflight[proRef].expected,
    stripeState: async () =>
      liveBillingState(stripe, proRow, usersById.get(proRow.userId).email),
  });

  const after = await prisma.subscription.findMany({
    select: { userId: true, tier: true, status: true, updatedAt: true },
  });
  const proRemaining = after.some((row) => opaqueRef(row.userId) === proRef);
  const agencyAfter = after.find(
    (row) => opaqueRef(row.userId) === "3a3074731701",
  );
  if (
    proRemaining ||
    !agencyAfter ||
    agencyAfter.updatedAt.getTime() !== rows["3a3074731701"].updatedAt.getTime()
  ) {
    throw new Error("post-cleanup invariant failed");
  }
  if (after.length !== allRows.length - 1)
    throw new Error("unrelated row-count invariant failed");

  return {
    preflight: {
      a8ec8e2ff400Unchanged: true,
      agencyUnchanged: true,
      validLiveSubscriptionFound: Object.values(preflight).some(
        (item) =>
          !item.stripeState.referencesAbsent ||
          item.stripeState.alternativeLiveSubscription,
      ),
    },
    agency: {
      intent: agencyIntent,
      deleted: false,
      reason: intentionalAgencyEvidence
        ? "INTENT_EVIDENCE_PRESENT"
        : "MANUAL_CONFIRMATION_REQUIRED",
    },
    cleanup: {
      proDeleted: proResult.deleted,
      agencyDeleted: false,
      rowsAffected: proResult.deleted ? 1 : 0,
    },
    verification: {
      proEntitlementRemaining: proRemaining,
      agencyEntitlementRemaining: true,
      checkoutBlockerRemovedForPro: !proRemaining,
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runCleanup(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({ error: "STALE_CLEANUP_ABORTED", reason: error.message }),
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
