CREATE TYPE "SignupPlanIntentStatus" AS ENUM ('SELECTED', 'CHECKOUT_CREATED', 'ACTIVATED');

CREATE TABLE "signup_plan_intents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "desiredTier" "PlanTier" NOT NULL,
    "status" "SignupPlanIntentStatus" NOT NULL DEFAULT 'SELECTED',
    "stripeCheckoutSessionId" TEXT,
    "checkoutUrl" TEXT,
    "checkoutAttempt" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signup_plan_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signup_plan_intents_userId_key"
ON "signup_plan_intents"("userId");

CREATE UNIQUE INDEX "signup_plan_intents_stripeCheckoutSessionId_key"
ON "signup_plan_intents"("stripeCheckoutSessionId");
