CREATE TYPE "AccountLifecycleRequestType" AS ENUM (
  'DELETE_ACCOUNT',
  'EXPORT_ACCOUNT'
);

CREATE TYPE "AccountLifecycleRequestStatus" AS ENUM (
  'PENDING',
  'VERIFIED',
  'PROCESSING',
  'COMPLETED',
  'REJECTED'
);

CREATE TABLE "account_lifecycle_requests" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "auth0Sub" TEXT NOT NULL,
  "emailSnapshot" TEXT NOT NULL,
  "type" "AccountLifecycleRequestType" NOT NULL,
  "status" "AccountLifecycleRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "operatorNotes" TEXT,
  CONSTRAINT "account_lifecycle_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_lifecycle_requests_userId_type_status_idx"
  ON "account_lifecycle_requests"("userId", "type", "status");
CREATE INDEX "account_lifecycle_requests_status_requestedAt_idx"
  ON "account_lifecycle_requests"("status", "requestedAt");
ALTER TABLE "account_lifecycle_requests"
  ADD CONSTRAINT "account_lifecycle_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
