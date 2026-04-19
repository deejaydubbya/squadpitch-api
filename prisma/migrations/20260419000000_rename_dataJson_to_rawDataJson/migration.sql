-- AlterTable: rename dataJson → rawDataJson on raw_metrics
ALTER TABLE "raw_metrics" RENAME COLUMN "dataJson" TO "rawDataJson";
