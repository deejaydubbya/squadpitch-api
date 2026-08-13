CREATE TYPE "WorkspaceLifecycle" AS ENUM ('CUSTOMER', 'PROSPECT');
CREATE TYPE "ProspectClaimStatus" AS ENUM ('CLAIMABLE', 'CLAIMED', 'REVOKED', 'EXPIRED');
CREATE TYPE "ProspectPreviewStatus" AS ENUM ('ACTIVE', 'REVOKED');

ALTER TABLE "clients"
ADD COLUMN "lifecycle" "WorkspaceLifecycle" NOT NULL DEFAULT 'CUSTOMER';

CREATE TABLE "prospect_workspaces" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "prospectName" TEXT NOT NULL,
  "prospectEmail" TEXT NOT NULL,
  "websiteUrl" TEXT,
  "sourceUrl" TEXT,
  "acquisitionSource" TEXT,
  "operatorNote" TEXT,
  "previewTokenHash" TEXT NOT NULL,
  "previewStatus" "ProspectPreviewStatus" NOT NULL DEFAULT 'ACTIVE',
  "claimTokenHash" TEXT,
  "claimStatus" "ProspectClaimStatus" NOT NULL DEFAULT 'CLAIMABLE',
  "claimIssuedAt" TIMESTAMP(3) NOT NULL,
  "claimExpiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "claimedByUserId" TEXT,
  "claimedByAuth0Sub" TEXT,
  "createdByAdminSub" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_workspaces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prospect_workspaces_clientId_key" ON "prospect_workspaces"("clientId");
CREATE UNIQUE INDEX "prospect_workspaces_previewTokenHash_key" ON "prospect_workspaces"("previewTokenHash");
CREATE UNIQUE INDEX "prospect_workspaces_claimTokenHash_key" ON "prospect_workspaces"("claimTokenHash");
CREATE INDEX "prospect_workspaces_claimStatus_claimExpiresAt_idx" ON "prospect_workspaces"("claimStatus", "claimExpiresAt");
CREATE INDEX "prospect_workspaces_prospectEmail_idx" ON "prospect_workspaces"("prospectEmail");
ALTER TABLE "prospect_workspaces" ADD CONSTRAINT "prospect_workspaces_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
