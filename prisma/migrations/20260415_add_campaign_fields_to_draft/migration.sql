-- AlterTable
ALTER TABLE "drafts" ADD COLUMN "campaignId" TEXT,
ADD COLUMN "campaignName" TEXT,
ADD COLUMN "campaignType" TEXT,
ADD COLUMN "campaignDay" INTEGER,
ADD COLUMN "campaignOrder" INTEGER,
ADD COLUMN "campaignTotal" INTEGER;

-- CreateIndex
CREATE INDEX "drafts_clientId_campaignId_idx" ON "drafts"("clientId", "campaignId");
