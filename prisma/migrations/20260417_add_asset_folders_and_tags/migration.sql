-- CreateTable
CREATE TABLE "asset_folders" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_folders_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN "folderId" TEXT;
ALTER TABLE "media_assets" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "asset_folders_clientId_idx" ON "asset_folders"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_folders_clientId_name_key" ON "asset_folders"("clientId", "name");

-- CreateIndex
CREATE INDEX "media_assets_clientId_folderId_idx" ON "media_assets"("clientId", "folderId");

-- AddForeignKey
ALTER TABLE "asset_folders" ADD CONSTRAINT "asset_folders_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "asset_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
