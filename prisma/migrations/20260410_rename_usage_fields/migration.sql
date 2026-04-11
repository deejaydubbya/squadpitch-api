-- Rename usage_records columns to match new spec
ALTER TABLE "usage_records" RENAME COLUMN "generations" TO "posts";
ALTER TABLE "usage_records" RENAME COLUMN "publishes" TO "images";
ALTER TABLE "usage_records" RENAME COLUMN "mediaGens" TO "videos";
