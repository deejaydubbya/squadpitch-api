-- CreateEnum
CREATE TYPE "PersonaType" AS ENUM ('AGENT', 'BRAND_STYLE', 'TEAM');

-- CreateEnum
CREATE TYPE "PersonaTrainingStatus" AS ENUM ('DRAFT', 'UPLOADING', 'READY_TO_TRAIN', 'QUEUED', 'TRAINING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "brand_personas" (
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "personaType" "PersonaType" NOT NULL DEFAULT 'AGENT',
    "name" TEXT,
    "status" "PersonaTrainingStatus" NOT NULL DEFAULT 'DRAFT',
    "trainingImages" JSONB NOT NULL DEFAULT '[]',
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "visualStyle" TEXT,
    "usageSettings" JSONB NOT NULL DEFAULT '{}',
    "trainingProgress" INTEGER DEFAULT 0,
    "previewImages" JSONB,
    "styleProfile" JSONB,
    "provider" TEXT DEFAULT 'fal',
    "providerTrainingId" TEXT,
    "providerModelId" TEXT,
    "triggerPhrase" TEXT,
    "errorMessage" TEXT,
    "consentAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_personas_pkey" PRIMARY KEY ("clientId")
);

-- AddForeignKey
ALTER TABLE "brand_personas" ADD CONSTRAINT "brand_personas_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
