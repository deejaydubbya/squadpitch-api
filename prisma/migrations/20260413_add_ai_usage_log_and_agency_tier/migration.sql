-- AlterEnum: Add AGENCY to PlanTier
ALTER TYPE "PlanTier" ADD VALUE 'AGENCY';

-- CreateEnum: AiActionType
CREATE TYPE "AiActionType" AS ENUM ('GENERATE_POST', 'REGENERATE', 'PARSE', 'IMAGE', 'VIDEO', 'IDEAS', 'ONBOARDING');

-- CreateTable: ai_usage_logs
CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT,
    "actionType" "AiActionType" NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_logs_userId_createdAt_idx" ON "ai_usage_logs"("userId", "createdAt");
CREATE INDEX "ai_usage_logs_clientId_createdAt_idx" ON "ai_usage_logs"("clientId", "createdAt");
