-- Existing deletion requests predate the grace-period state. Preserve their
-- original request time and make them eligible for the same idempotent worker.
UPDATE "account_lifecycle_requests"
SET
  "status" = 'GRACE_PERIOD',
  "graceEndsAt" = "requestedAt" + INTERVAL '7 days'
WHERE
  "type" = 'DELETE_ACCOUNT'
  AND "status" IN ('PENDING', 'VERIFIED', 'PROCESSING')
  AND "completedAt" IS NULL;

-- Existing export requests get the approved seven-day request lifetime.
UPDATE "account_lifecycle_requests"
SET "exportExpiresAt" = "requestedAt" + INTERVAL '7 days'
WHERE
  "type" = 'EXPORT_ACCOUNT'
  AND "exportExpiresAt" IS NULL;
