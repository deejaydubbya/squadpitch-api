import { pathToFileURL } from "node:url";

import { prisma } from "../../prisma.js";
import { summarizeStripeMigrationState } from "./state.js";

export async function inspectStripeMigrationState() {
  const [subscriptions, intents] = await Promise.all([
    prisma.subscription.findMany({
      select: {
        userId: true,
        tier: true,
        status: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        lastStripeEventId: true,
        lastStripeEventCreated: true,
      },
    }),
    prisma.signupPlanIntent.findMany({
      select: {
        userId: true,
        status: true,
        stripeCheckoutSessionId: true,
      },
    }),
  ]);
  return summarizeStripeMigrationState(subscriptions, intents);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = process.argv.includes("--json");
  try {
    const report = await inspectStripeMigrationState();
    if (!json) console.log("Stripe migration inspection (read-only)");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
