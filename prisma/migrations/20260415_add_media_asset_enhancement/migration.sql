-- Add screenshot-import enhancement metadata to MediaAsset
ALTER TABLE "media_assets"
  ADD COLUMN "isEnhanced" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "qualityScore" DOUBLE PRECISION,
  ADD COLUMN "qualityLabel" TEXT;
