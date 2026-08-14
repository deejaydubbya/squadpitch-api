ALTER TABLE "media_assets" ADD COLUMN "propertyDataItemId" TEXT;
ALTER TABLE "media_assets" ADD COLUMN "sourceKey" TEXT;
ALTER TABLE "asset_folders" ADD COLUMN "propertyDataItemId" TEXT;

CREATE INDEX "media_assets_propertyDataItemId_idx" ON "media_assets"("propertyDataItemId");
CREATE UNIQUE INDEX "media_assets_clientId_propertyDataItemId_sourceKey_key" ON "media_assets"("clientId", "propertyDataItemId", "sourceKey");
CREATE UNIQUE INDEX "asset_folders_propertyDataItemId_key" ON "asset_folders"("propertyDataItemId");

ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_propertyDataItemId_fkey" FOREIGN KEY ("propertyDataItemId") REFERENCES "workspace_data_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_folders" ADD CONSTRAINT "asset_folders_propertyDataItemId_fkey" FOREIGN KEY ("propertyDataItemId") REFERENCES "workspace_data_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
