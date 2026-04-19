-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN "imageGenerations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage_records" ADD COLUMN "videoGenerations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage_records" ADD COLUMN "enhancementRuns" INTEGER NOT NULL DEFAULT 0;
