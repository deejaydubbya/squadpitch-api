import { prisma } from "../../prisma.js";
import { inspectStripeMigrationState } from "./inspect.js";
import { parseResetAuthorization } from "./state.js";

const authorization = parseResetAuthorization(process.argv.slice(2));
if (authorization.errors.length) {
  throw new Error(`Stripe reset refused: ${authorization.errors.join("; ")}`);
}

try {
  const before = await inspectStripeMigrationState();
  if (
    before.subscription.total !== authorization.expectedSubscriptions ||
    before.signupPlanIntent.total !== authorization.expectedIntents
  ) {
    throw new Error("Stripe reset refused: inspected counts changed");
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const intents = await tx.signupPlanIntent.deleteMany({});
    const subscriptions = await tx.subscription.deleteMany({});
    return { subscriptions: subscriptions.count, signupPlanIntents: intents.count };
  });

  const after = await inspectStripeMigrationState();
  if (after.subscription.total !== 0 || after.signupPlanIntent.total !== 0) {
    throw new Error("Stripe reset verification failed");
  }
  console.log(JSON.stringify({ reset: "complete", deleted, remaining: after }, null, 2));
} finally {
  await prisma.$disconnect();
}
