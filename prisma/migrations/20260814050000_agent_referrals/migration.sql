CREATE TYPE "ReferralStatus" AS ENUM ('ATTRIBUTED', 'QUALIFYING', 'REWARDED', 'DISQUALIFIED');
CREATE TYPE "ReferralRewardStatus" AS ENUM ('PENDING', 'PROCESSING', 'GRANTED', 'FAILED');

CREATE TABLE "referral_codes" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "referrals" (
  "id" TEXT NOT NULL,
  "referralCodeId" TEXT NOT NULL,
  "referrerUserId" TEXT NOT NULL,
  "referredUserId" TEXT NOT NULL,
  "status" "ReferralStatus" NOT NULL DEFAULT 'ATTRIBUTED',
  "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "qualifyingSince" TIMESTAMP(3),
  "qualifiesAt" TIMESTAMP(3),
  "disqualifiedAt" TIMESTAMP(3),
  "disqualificationReason" TEXT,
  "stripeSubscriptionId" TEXT,
  "stripeConversionEventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "referral_rewards" (
  "id" TEXT NOT NULL,
  "referralId" TEXT NOT NULL,
  "status" "ReferralRewardStatus" NOT NULL DEFAULT 'PENDING',
  "amountCents" INTEGER NOT NULL DEFAULT 5900,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "idempotencyKey" TEXT NOT NULL,
  "stripeCustomerId" TEXT,
  "stripeBalanceTransactionId" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "grantedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "referral_stripe_events" (
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "referralId" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_stripe_events_pkey" PRIMARY KEY ("eventId")
);

CREATE UNIQUE INDEX "referral_codes_ownerUserId_key" ON "referral_codes"("ownerUserId");
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");
CREATE INDEX "referral_codes_active_idx" ON "referral_codes"("active");
CREATE UNIQUE INDEX "referrals_referredUserId_key" ON "referrals"("referredUserId");
CREATE UNIQUE INDEX "referrals_stripeConversionEventId_key" ON "referrals"("stripeConversionEventId");
CREATE INDEX "referrals_referrerUserId_createdAt_idx" ON "referrals"("referrerUserId", "createdAt");
CREATE INDEX "referrals_status_qualifiesAt_idx" ON "referrals"("status", "qualifiesAt");
CREATE UNIQUE INDEX "referral_rewards_referralId_key" ON "referral_rewards"("referralId");
CREATE UNIQUE INDEX "referral_rewards_idempotencyKey_key" ON "referral_rewards"("idempotencyKey");
CREATE UNIQUE INDEX "referral_rewards_stripeBalanceTransactionId_key" ON "referral_rewards"("stripeBalanceTransactionId");
CREATE INDEX "referral_rewards_status_lastAttemptAt_idx" ON "referral_rewards"("status", "lastAttemptAt");
CREATE INDEX "referral_stripe_events_referralId_processedAt_idx" ON "referral_stripe_events"("referralId", "processedAt");

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "referral_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_stripe_events" ADD CONSTRAINT "referral_stripe_events_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
