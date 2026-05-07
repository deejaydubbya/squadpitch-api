-- Add Stripe webhook ordering guard fields to Subscription.
ALTER TABLE "subscriptions" ADD COLUMN "lastStripeEventCreated" INTEGER;
ALTER TABLE "subscriptions" ADD COLUMN "lastStripeEventId" TEXT;
