import { pathToFileURL } from "node:url";
import Stripe from "stripe";

import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { STRIPE_API_VERSION } from "../../domains/billing/stripeSafety.js";
import {
  assertRestrictedLiveKey,
  reconcileStripeBilling,
} from "./reconcile.js";
import { assertStaticReadOnlyPath } from "./safety.js";

function configuredCatalog() {
  const entries = [
    ["STARTER", env.STRIPE_STARTER_PRICE_ID, env.STRIPE_STARTER_PRODUCT_ID],
    ["PRO", env.STRIPE_PRO_PRICE_ID, env.STRIPE_PRO_PRODUCT_ID],
    ["GROWTH", env.STRIPE_GROWTH_PRICE_ID, env.STRIPE_GROWTH_PRODUCT_ID],
  ]
    .filter(([, priceId, productId]) => priceId && productId)
    .map(([tier, priceId, productId]) => ({ tier, priceId, productId }));
  return {
    entries,
    priceToTier: Object.fromEntries(
      entries.map(({ tier, priceId }) => [priceId, tier]),
    ),
  };
}

function stripeAdapter(client) {
  return {
    retrieveCustomer: (id) => client.customers.retrieve(id),
    retrieveSubscription: (id) => client.subscriptions.retrieve(id),
    listSubscriptions: async (customer) => {
      const rows = [];
      for await (const subscription of client.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      })) {
        rows.push(subscription);
      }
      return rows;
    },
    retrievePrice: (id) => client.prices.retrieve(id),
    retrieveProduct: (id) => client.products.retrieve(id),
    listRecentEvents: () => client.events.list({ limit: 100 }),
  };
}

export async function runStripeReconciliation({
  restrictedKey = process.env.STRIPE_DR_RESTRICTED_KEY,
} = {}) {
  await assertStaticReadOnlyPath();
  assertRestrictedLiveKey(restrictedKey);
  const client = new Stripe(restrictedKey, { apiVersion: STRIPE_API_VERSION });
  const localRows = await prisma.subscription.findMany({
    select: {
      userId: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      tier: true,
      status: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: true,
      lastStripeEventId: true,
      lastStripeEventCreated: true,
    },
  });
  return reconcileStripeBilling({
    localRows,
    catalog: configuredCatalog(),
    stripe: stripeAdapter(client),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runStripeReconciliation(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        schemaVersion: "stripe-reconciliation.v1",
        error: "STRIPE_RECONCILIATION_FAILED",
        reason: error?.statusCode
          ? `HTTP_${error.statusCode}`
          : "VERIFICATION_FAILED",
      }),
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
