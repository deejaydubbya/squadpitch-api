-- AlterTable
ALTER TABLE "brand_profiles" ADD COLUMN "city" TEXT;
ALTER TABLE "brand_profiles" ADD COLUMN "state" TEXT;
ALTER TABLE "brand_profiles" ADD COLUMN "marketArea" TEXT;
ALTER TABLE "brand_profiles" ADD COLUMN "primaryZip" TEXT;
ALTER TABLE "brand_profiles" ADD COLUMN "serviceAreas" JSONB;
