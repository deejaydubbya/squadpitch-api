-- Add requestHeaders, deliveredAt, and replayOfId to webhook_delivery_logs

ALTER TABLE "webhook_delivery_logs" ADD COLUMN "requestHeaders" JSONB;
ALTER TABLE "webhook_delivery_logs" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "webhook_delivery_logs" ADD COLUMN "replayOfId" TEXT;

-- Index for finding replays of a given delivery
CREATE INDEX "webhook_delivery_logs_replayOfId_idx" ON "webhook_delivery_logs"("replayOfId");
