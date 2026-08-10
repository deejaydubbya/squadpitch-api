import { createHash } from "node:crypto";

const BILLABLE_STRIPE_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);
const STATUS_MAP = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  unpaid: "PAST_DUE",
  canceled: "CANCELED",
  incomplete: "CANCELED",
  incomplete_expired: "CANCELED",
  paused: "CANCELED",
};

export function opaqueRef(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

export function assertRestrictedLiveKey(key) {
  if (typeof key !== "string" || !key.startsWith("rk_live_")) {
    throw new Error("STRIPE_DR_RESTRICTED_KEY must be a live restricted key");
  }
}

function stripePeriodEnd(subscription) {
  return (
    subscription.current_period_end ??
    subscription.items?.data?.[0]?.current_period_end ??
    null
  );
}

function activePriceId(subscription) {
  return subscription.items?.data?.[0]?.price?.id ?? null;
}

function normalizedLocalPeriod(value) {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function ownershipState(subscription, customer, localUserBySubscription) {
  const subscriptionUser = subscription?.metadata?.userId || null;
  const customerUser = customer?.metadata?.userId || null;
  const localUser = localUserBySubscription.get(subscription.id) || null;
  const candidates = new Set(
    [subscriptionUser, customerUser, localUser].filter(Boolean),
  );
  return {
    reconstructable:
      Boolean(subscriptionUser || customerUser) && candidates.size === 1,
    ambiguous: candidates.size > 1,
  };
}

function duplicateCount(rows, key) {
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    if (seen.has(value)) duplicates += 1;
    seen.add(value);
  }
  return duplicates;
}

export async function reconcileStripeBilling({
  localRows,
  catalog,
  stripe,
  periodToleranceSeconds = 1,
}) {
  const mismatchCounts = {
    missingCustomer: 0,
    missingSubscription: 0,
    status: 0,
    priceTier: 0,
    cancellation: 0,
    period: 0,
  };
  const mismatchRefs = [];
  const customers = new Map();
  const subscriptions = new Map();
  const localSubscriptionIds = new Set(
    localRows.map((row) => row.stripeSubscriptionId).filter(Boolean),
  );
  const localUserBySubscription = new Map(
    localRows
      .filter((row) => row.stripeSubscriptionId)
      .map((row) => [row.stripeSubscriptionId, row.userId]),
  );
  let matched = 0;

  for (const row of localRows) {
    const rowMismatches = [];
    let customer = customers.get(row.stripeCustomerId);
    if (customer === undefined) {
      try {
        customer = await stripe.retrieveCustomer(row.stripeCustomerId);
      } catch (error) {
        if (error?.code !== "resource_missing") throw error;
        customer = null;
      }
      customers.set(row.stripeCustomerId, customer);
    }
    if (!customer || customer.deleted) {
      mismatchCounts.missingCustomer += 1;
      rowMismatches.push("missingCustomer");
    }

    let subscription = null;
    if (row.stripeSubscriptionId) {
      try {
        subscription = await stripe.retrieveSubscription(
          row.stripeSubscriptionId,
        );
      } catch (error) {
        if (error?.code !== "resource_missing") throw error;
      }
    }
    if (row.stripeSubscriptionId && !subscription) {
      mismatchCounts.missingSubscription += 1;
      rowMismatches.push("missingSubscription");
    }
    if (subscription) {
      subscriptions.set(subscription.id, { subscription, customer });
      const expectedStatus = STATUS_MAP[subscription.status] ?? "CANCELED";
      if (expectedStatus !== row.status) {
        mismatchCounts.status += 1;
        rowMismatches.push("status");
      }
      const expectedTier = catalog.priceToTier[activePriceId(subscription)];
      if (!expectedTier || expectedTier !== row.tier) {
        mismatchCounts.priceTier += 1;
        rowMismatches.push("priceTier");
      }
      if (
        Boolean(subscription.cancel_at_period_end) !==
        Boolean(row.cancelAtPeriodEnd)
      ) {
        mismatchCounts.cancellation += 1;
        rowMismatches.push("cancellation");
      }
      const stripeEnd = stripePeriodEnd(subscription);
      const localEnd = normalizedLocalPeriod(row.currentPeriodEnd);
      if (
        (stripeEnd == null) !== (localEnd == null) ||
        (stripeEnd != null &&
          Math.abs(stripeEnd - localEnd) > periodToleranceSeconds)
      ) {
        mismatchCounts.period += 1;
        rowMismatches.push("period");
      }
    }
    if (rowMismatches.length === 0) matched += 1;
    else
      mismatchRefs.push({
        ref: opaqueRef(row.userId),
        categories: rowMismatches,
      });
  }

  let orphanCount = 0;
  for (const [customerId, customer] of customers) {
    if (!customer || customer.deleted) continue;
    const listed = await stripe.listSubscriptions(customerId);
    for (const subscription of listed) {
      if (!BILLABLE_STRIPE_STATUSES.has(subscription.status)) continue;
      if (!localSubscriptionIds.has(subscription.id)) orphanCount += 1;
      if (!subscriptions.has(subscription.id))
        subscriptions.set(subscription.id, { subscription, customer });
    }
  }

  let reconstructable = 0;
  let manualReview = 0;
  let ambiguousOwnership = 0;
  for (const { subscription, customer } of subscriptions.values()) {
    if (!BILLABLE_STRIPE_STATUSES.has(subscription.status)) continue;
    const ownership = ownershipState(
      subscription,
      customer,
      localUserBySubscription,
    );
    if (ownership.reconstructable) reconstructable += 1;
    else manualReview += 1;
    if (ownership.ambiguous) ambiguousOwnership += 1;
  }

  let catalogPass = catalog.entries.length > 0;
  for (const entry of catalog.entries) {
    try {
      const [price, product] = await Promise.all([
        stripe.retrievePrice(entry.priceId),
        stripe.retrieveProduct(entry.productId),
      ]);
      const productId =
        typeof price.product === "string" ? price.product : price.product?.id;
      if (
        !price ||
        !product ||
        price.deleted ||
        product.deleted ||
        productId !== entry.productId
      )
        catalogPass = false;
    } catch {
      catalogPass = false;
    }
  }

  let recentEventsPass = true;
  let eventMarkerIncoherent = 0;
  try {
    const eventPage = await stripe.listRecentEvents();
    const recentEvents = new Map(
      (eventPage?.data ?? eventPage ?? []).map((event) => [event.id, event]),
    );
    for (const row of localRows) {
      const hasId = Boolean(row.lastStripeEventId);
      const hasCreated = Number.isInteger(row.lastStripeEventCreated);
      if (hasId !== hasCreated) {
        eventMarkerIncoherent += 1;
        continue;
      }
      const recent = hasId ? recentEvents.get(row.lastStripeEventId) : null;
      if (recent && recent.created !== row.lastStripeEventCreated)
        eventMarkerIncoherent += 1;
    }
  } catch {
    recentEventsPass = false;
  }

  return {
    schemaVersion: "stripe-reconciliation.v1",
    reconciliation: {
      localRecordsChecked: localRows.length,
      stripeCustomersChecked: customers.size,
      subscriptionsChecked: [...subscriptions.values()].filter(
        ({ subscription }) => BILLABLE_STRIPE_STATUSES.has(subscription.status),
      ).length,
      exactMatches: matched,
      mismatches: Object.values(mismatchCounts).reduce(
        (sum, count) => sum + count,
        0,
      ),
      mismatchCounts,
      mismatchRefs,
      orphans: orphanCount,
      duplicateOwnership:
        duplicateCount(localRows, "userId") +
        duplicateCount(localRows, "stripeCustomerId") +
        duplicateCount(localRows, "stripeSubscriptionId"),
      catalogMapping: catalogPass ? "PASS" : "FAIL",
      recentEventsAccess: recentEventsPass ? "PASS" : "FAIL",
      eventMarkerIncoherent,
    },
    reconstructability: {
      automaticallyReconstructable: reconstructable,
      manualReviewRequired: manualReview,
      ownershipMetadataSufficient:
        manualReview === 0 ? "yes" : reconstructable === 0 ? "no" : "partial",
      metadataFields: [
        "subscription.metadata.userId",
        "customer.metadata.userId",
      ],
      ambiguousOwnership,
    },
  };
}
