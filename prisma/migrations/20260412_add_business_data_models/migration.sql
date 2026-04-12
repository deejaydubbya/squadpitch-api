-- CreateEnum
CREATE TYPE "DataSourceType" AS ENUM ('MANUAL');

-- CreateEnum
CREATE TYPE "DataItemStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DataItemType" AS ENUM ('TESTIMONIAL', 'CASE_STUDY', 'PRODUCT_LAUNCH', 'PROMOTION', 'STATISTIC', 'MILESTONE', 'FAQ', 'TEAM_SPOTLIGHT', 'INDUSTRY_NEWS', 'EVENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BlueprintCategory" AS ENUM ('SOCIAL_PROOF', 'EDUCATION', 'BEHIND_THE_SCENES', 'PROMOTION', 'ENGAGEMENT', 'STORYTELLING', 'AUTHORITY', 'SEASONAL');

-- CreateTable
CREATE TABLE "workspace_data_sources" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "DataSourceType" NOT NULL DEFAULT 'MANUAL',
    "name" TEXT NOT NULL,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_data_items" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "type" "DataItemType" NOT NULL,
    "status" "DataItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "dataJson" JSONB NOT NULL,
    "tags" TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_data_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_blueprints" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "BlueprintCategory" NOT NULL,
    "promptTemplate" TEXT NOT NULL,
    "applicableTypes" "DataItemType"[],
    "applicableChannels" "Channel"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_content_sources" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "dataItemId" TEXT NOT NULL,
    "blueprintId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_content_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_item_performance" (
    "id" TEXT NOT NULL,
    "dataItemId" TEXT NOT NULL,
    "totalDrafts" INTEGER NOT NULL DEFAULT 0,
    "totalPublished" INTEGER NOT NULL DEFAULT 0,
    "avgEngagement" DOUBLE PRECISION,
    "lastCalculated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_item_performance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_performance" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT NOT NULL,
    "totalDrafts" INTEGER NOT NULL DEFAULT 0,
    "totalPublished" INTEGER NOT NULL DEFAULT 0,
    "avgEngagement" DOUBLE PRECISION,
    "lastCalculated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blueprint_performance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_data_sources_clientId_idx" ON "workspace_data_sources"("clientId");

-- CreateIndex
CREATE INDEX "workspace_data_items_clientId_status_idx" ON "workspace_data_items"("clientId", "status");

-- CreateIndex
CREATE INDEX "workspace_data_items_clientId_type_idx" ON "workspace_data_items"("clientId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "content_blueprints_slug_key" ON "content_blueprints"("slug");

-- CreateIndex
CREATE INDEX "content_blueprints_category_idx" ON "content_blueprints"("category");

-- CreateIndex
CREATE INDEX "generated_content_sources_draftId_idx" ON "generated_content_sources"("draftId");

-- CreateIndex
CREATE INDEX "generated_content_sources_dataItemId_idx" ON "generated_content_sources"("dataItemId");

-- CreateIndex
CREATE INDEX "generated_content_sources_blueprintId_idx" ON "generated_content_sources"("blueprintId");

-- CreateIndex
CREATE UNIQUE INDEX "data_item_performance_dataItemId_key" ON "data_item_performance"("dataItemId");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_performance_blueprintId_key" ON "blueprint_performance"("blueprintId");

-- AddForeignKey
ALTER TABLE "workspace_data_sources" ADD CONSTRAINT "workspace_data_sources_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_data_items" ADD CONSTRAINT "workspace_data_items_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_data_items" ADD CONSTRAINT "workspace_data_items_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "workspace_data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_content_sources" ADD CONSTRAINT "generated_content_sources_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_content_sources" ADD CONSTRAINT "generated_content_sources_dataItemId_fkey" FOREIGN KEY ("dataItemId") REFERENCES "workspace_data_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_content_sources" ADD CONSTRAINT "generated_content_sources_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "content_blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_item_performance" ADD CONSTRAINT "data_item_performance_dataItemId_fkey" FOREIGN KEY ("dataItemId") REFERENCES "workspace_data_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_performance" ADD CONSTRAINT "blueprint_performance_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "content_blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
