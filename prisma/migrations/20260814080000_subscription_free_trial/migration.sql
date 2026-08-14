ALTER TABLE "subscriptions"
  ADD COLUMN "trialConsumedAt" TIMESTAMP(3),
  ADD COLUMN "trialStart" TIMESTAMP(3),
  ADD COLUMN "trialEnd" TIMESTAMP(3),
  ADD COLUMN "trialTier" "PlanTier",
  ADD COLUMN "trialState" TEXT;

CREATE INDEX "subscriptions_trialState_trialEnd_idx"
  ON "subscriptions"("trialState", "trialEnd");

CREATE TABLE "trial_consumptions" (
  "id" TEXT NOT NULL,
  "identityHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "state" TEXT NOT NULL,
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trial_consumptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trial_consumptions_identityHash_key" ON "trial_consumptions"("identityHash");
CREATE UNIQUE INDEX "trial_consumptions_stripeSubscriptionId_key" ON "trial_consumptions"("stripeSubscriptionId");
CREATE INDEX "trial_consumptions_userId_consumedAt_idx" ON "trial_consumptions"("userId", "consumedAt");
