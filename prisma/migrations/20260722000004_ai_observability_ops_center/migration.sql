CREATE TYPE "AiRunStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'REJECTED');
CREATE TYPE "AiReleaseGateStage" AS ENUM ('OFFLINE', 'SHADOW', 'BETA', 'GENERAL_RELEASE');

CREATE TABLE "ai_run_traces" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "clientId" TEXT,
  "actorUserId" TEXT,
  "taskType" TEXT NOT NULL,
  "featureFlags" JSONB,
  "provider" TEXT,
  "model" TEXT,
  "promptVersion" TEXT,
  "schemaVersion" TEXT,
  "retrievalRunId" TEXT,
  "retrievedSources" JSONB,
  "steps" JSONB,
  "validationResults" JSONB,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "estimatedCostCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "latencyMs" INTEGER,
  "status" "AiRunStatus" NOT NULL,
  "errorCode" TEXT,
  "errorSeverity" TEXT,
  "humanOutcome" TEXT,
  "downstreamCampaignIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "downstreamDraftIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "outcomePointers" JSONB,
  "releaseGateStage" "AiReleaseGateStage" NOT NULL DEFAULT 'OFFLINE',
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  "debugAccessLevel" TEXT NOT NULL DEFAULT 'admin_only',
  "rawContentCaptured" BOOLEAN NOT NULL DEFAULT false,
  "redactionVersion" TEXT NOT NULL DEFAULT 'ai-trace-redaction.v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_run_traces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_run_traces_traceId_idx" ON "ai_run_traces"("traceId");
CREATE INDEX "ai_run_traces_requestId_idx" ON "ai_run_traces"("requestId");
CREATE INDEX "ai_run_traces_clientId_createdAt_idx" ON "ai_run_traces"("clientId", "createdAt");
CREATE INDEX "ai_run_traces_taskType_status_idx" ON "ai_run_traces"("taskType", "status");
CREATE INDEX "ai_run_traces_provider_model_idx" ON "ai_run_traces"("provider", "model");
CREATE INDEX "ai_run_traces_errorCode_idx" ON "ai_run_traces"("errorCode");
CREATE INDEX "ai_run_traces_retentionUntil_idx" ON "ai_run_traces"("retentionUntil");

ALTER TABLE "ai_run_traces"
  ADD CONSTRAINT "ai_run_traces_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
