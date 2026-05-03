-- Add missing columns to media_assets (persona, AI generation params, enhancement metadata)

-- AI generation parameters
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "falModelId" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "renderedPrompt" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "negativePrompt" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "loraSnapshot" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "loraScaleSnapshot" DOUBLE PRECISION;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "personaSnapshot" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "seed" BIGINT;

-- Enhancement metadata (missed from 20260415_add_media_asset_enhancement)
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "externalJobId" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "durationMs" INTEGER;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "progressStage" TEXT;
