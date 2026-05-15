-- SquadInbox outbound — Message delivery lifecycle.
--
-- New enum MessageDeliveryStatus + four nullable columns on
-- messages. Powers the first real outbound channel (email via
-- Postmark). Existing rows (FORM_SUBMISSION, MANUAL_LOG) keep
-- deliveryStatus NULL — they represent thread events, not real
-- provider sends.
--
-- No data risk: pure additive.

CREATE TYPE "MessageDeliveryStatus" AS ENUM (
  'DRAFT',
  'SENDING',
  'SENT',
  'FAILED'
);

ALTER TABLE "messages"
  ADD COLUMN "deliveryStatus"    "MessageDeliveryStatus",
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "errorReason"       TEXT,
  ADD COLUMN "lastAttemptedAt"   TIMESTAMP(3);

CREATE INDEX "messages_deliveryStatus_idx"
  ON "messages"("deliveryStatus");
