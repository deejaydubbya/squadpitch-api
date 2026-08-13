CREATE TYPE "ProspectPreviewItemType" AS ENUM ('DATA_ITEM', 'DRAFT');

CREATE TABLE "prospect_preview_items" (
    "id" TEXT NOT NULL,
    "prospectWorkspaceId" TEXT NOT NULL,
    "itemType" "ProspectPreviewItemType" NOT NULL,
    "dataItemId" TEXT,
    "draftId" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "prospect_preview_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prospect_preview_items_exactly_one_reference" CHECK (
      ("itemType" = 'DATA_ITEM' AND "dataItemId" IS NOT NULL AND "draftId" IS NULL) OR
      ("itemType" = 'DRAFT' AND "draftId" IS NOT NULL AND "dataItemId" IS NULL)
    )
);

CREATE UNIQUE INDEX "prospect_preview_items_prospectWorkspaceId_dataItemId_key" ON "prospect_preview_items"("prospectWorkspaceId", "dataItemId");
CREATE UNIQUE INDEX "prospect_preview_items_prospectWorkspaceId_draftId_key" ON "prospect_preview_items"("prospectWorkspaceId", "draftId");
CREATE UNIQUE INDEX "prospect_preview_items_prospectWorkspaceId_sortOrder_key" ON "prospect_preview_items"("prospectWorkspaceId", "sortOrder");
CREATE INDEX "prospect_preview_items_dataItemId_idx" ON "prospect_preview_items"("dataItemId");
CREATE INDEX "prospect_preview_items_draftId_idx" ON "prospect_preview_items"("draftId");

ALTER TABLE "prospect_preview_items" ADD CONSTRAINT "prospect_preview_items_prospectWorkspaceId_fkey" FOREIGN KEY ("prospectWorkspaceId") REFERENCES "prospect_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prospect_preview_items" ADD CONSTRAINT "prospect_preview_items_dataItemId_fkey" FOREIGN KEY ("dataItemId") REFERENCES "workspace_data_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prospect_preview_items" ADD CONSTRAINT "prospect_preview_items_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
