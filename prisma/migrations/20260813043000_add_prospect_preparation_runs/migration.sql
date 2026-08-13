CREATE TYPE "ProspectPreparationStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETE', 'COMPLETE_WITH_WARNINGS', 'FAILED');
CREATE TYPE "ProspectPreparationStage" AS ENUM ('QUEUED', 'IMPORTING_LISTING', 'ENRICHING', 'PROCESSING_MEDIA', 'GENERATING', 'SELECTING', 'COMPLETE', 'FAILED');

CREATE TABLE "prospect_preparation_runs" (
  "id" TEXT NOT NULL,
  "prospectWorkspaceId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "status" "ProspectPreparationStatus" NOT NULL DEFAULT 'QUEUED',
  "stage" "ProspectPreparationStage" NOT NULL DEFAULT 'QUEUED',
  "platformStates" JSONB NOT NULL,
  "readyCount" INTEGER NOT NULL DEFAULT 0,
  "expectedCount" INTEGER NOT NULL DEFAULT 3,
  "warningCount" INTEGER NOT NULL DEFAULT 0,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_preparation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_preparation_runs_prospectWorkspaceId_fkey" FOREIGN KEY ("prospectWorkspaceId") REFERENCES "prospect_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "prospect_preparation_runs_prospectWorkspaceId_createdAt_idx" ON "prospect_preparation_runs"("prospectWorkspaceId", "createdAt");
CREATE INDEX "prospect_preparation_runs_status_heartbeatAt_idx" ON "prospect_preparation_runs"("status", "heartbeatAt");
CREATE UNIQUE INDEX "prospect_preparation_runs_one_active_idx" ON "prospect_preparation_runs"("prospectWorkspaceId") WHERE "status" IN ('QUEUED', 'RUNNING');
