-- Add scoredHooks JSON column to drafts for hook quality scoring
ALTER TABLE "drafts" ADD COLUMN "scoredHooks" JSONB;
