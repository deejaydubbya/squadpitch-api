CREATE TYPE "AiActionProposalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'FAILED');
CREATE TYPE "AiActionProposalType" AS ENUM ('DRAFT_CONTENT', 'CAMPAIGN_DRAFT_SET');

CREATE TABLE "ai_action_proposals" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "proposalType" "AiActionProposalType" NOT NULL,
  "proposalVersion" TEXT NOT NULL DEFAULT 'draft-proposal.v1',
  "schemaVersion" TEXT NOT NULL,
  "status" "AiActionProposalStatus" NOT NULL DEFAULT 'PROPOSED',
  "idempotencyKey" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "sourceTraceId" TEXT,
  "sourceEvalVersion" TEXT,
  "sourceModelVersion" TEXT,
  "sourcePromptVersion" TEXT,
  "proposalPayload" JSONB NOT NULL,
  "validationResults" JSONB NOT NULL,
  "auditMetadata" JSONB,
  "resultingCampaignIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "resultingDraftIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "approverUserId" TEXT,
  "rejectionReason" TEXT,
  CONSTRAINT "ai_action_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_action_proposals_clientId_idempotencyKey_key"
  ON "ai_action_proposals"("clientId", "idempotencyKey");
CREATE INDEX "ai_action_proposals_clientId_status_idx"
  ON "ai_action_proposals"("clientId", "status");
CREATE INDEX "ai_action_proposals_expiresAt_idx"
  ON "ai_action_proposals"("expiresAt");

ALTER TABLE "ai_action_proposals"
  ADD CONSTRAINT "ai_action_proposals_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
