-- Add performance rating fields to drafts
ALTER TABLE "drafts" ADD COLUMN "performanceRating" TEXT;
ALTER TABLE "drafts" ADD COLUMN "ratedAt" TIMESTAMP(3);
