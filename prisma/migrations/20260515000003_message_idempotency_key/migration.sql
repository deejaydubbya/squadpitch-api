-- SquadInbox outbound — idempotency key on Message.
--
-- A nullable text column + a partial-style composite unique
-- (conversationId, idempotencyKey). NULL values don't conflict
-- with other NULLs in Postgres for unique-constraint purposes,
-- so legacy rows (and any Message that wasn't an outbound send)
-- stay safe.
--
-- No data risk: pure additive.

ALTER TABLE "messages"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "messages_conversationId_idempotencyKey_key"
  ON "messages"("conversationId", "idempotencyKey");
