ALTER TYPE "AccountLifecycleRequestStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';
ALTER TYPE "AccountLifecycleRequestStatus" ADD VALUE IF NOT EXISTS 'PURGING';
ALTER TYPE "AccountLifecycleRequestStatus" ADD VALUE IF NOT EXISTS 'PARTIAL_PROVIDER_FAILURE';
ALTER TYPE "AccountLifecycleRequestStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE TYPE "AccountDeletionProvider" AS ENUM ('CLOUDINARY', 'AUTH0');
CREATE TYPE "AccountDeletionProviderTaskStatus" AS ENUM ('PENDING', 'RETRY', 'COMPLETED');

ALTER TABLE "account_lifecycle_requests"
  ADD COLUMN "graceEndsAt" TIMESTAMP(3),
  ADD COLUMN "exportExpiresAt" TIMESTAMP(3),
  ADD COLUMN "tombstoneUntil" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "workspaceSnapshot" JSONB;

CREATE TABLE "account_deletion_provider_tasks" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "provider" "AccountDeletionProvider" NOT NULL,
  "targetEncrypted" TEXT NOT NULL,
  "targetHash" TEXT NOT NULL,
  "resourceType" TEXT,
  "status" "AccountDeletionProviderTaskStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "account_deletion_provider_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_deletion_provider_tasks_requestId_provider_targetHash_key"
  ON "account_deletion_provider_tasks"("requestId", "provider", "targetHash");
CREATE INDEX "account_deletion_provider_tasks_status_nextAttemptAt_idx"
  ON "account_deletion_provider_tasks"("status", "nextAttemptAt");
ALTER TABLE "account_deletion_provider_tasks"
  ADD CONSTRAINT "account_deletion_provider_tasks_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "account_lifecycle_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
