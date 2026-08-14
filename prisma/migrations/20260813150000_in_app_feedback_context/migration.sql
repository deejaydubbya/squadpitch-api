ALTER TABLE "beta_feedback"
  ADD COLUMN "submitterEmail" TEXT,
  ADD COLUMN "submitterName" TEXT,
  ADD COLUMN "workspaceName" TEXT,
  ADD COLUMN "releaseVersion" TEXT,
  ADD COLUMN "deviceClass" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "resolvedBy" TEXT;

CREATE UNIQUE INDEX "beta_feedback_idempotencyKey_key" ON "beta_feedback"("idempotencyKey");

UPDATE "beta_feedback" SET "severity" = CASE "severity"
  WHEN 'critical' THEN 'urgent' WHEN 'medium' THEN 'normal' ELSE "severity" END;
UPDATE "beta_feedback" SET "status" = CASE "status"
  WHEN 'triaged' THEN 'reviewing' WHEN 'in_progress' THEN 'reviewing'
  WHEN 'wont_fix' THEN 'closed' WHEN 'duplicate' THEN 'closed' ELSE "status" END;
ALTER TABLE "beta_feedback" ALTER COLUMN "severity" SET DEFAULT 'normal';
