-- CreateTable
CREATE TABLE "draft_assets" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "draft_assets_assetId_idx" ON "draft_assets"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "draft_assets_draftId_assetId_key" ON "draft_assets"("draftId", "assetId");

-- AddForeignKey
ALTER TABLE "draft_assets" ADD CONSTRAINT "draft_assets_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_assets" ADD CONSTRAINT "draft_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
