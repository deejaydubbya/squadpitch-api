-- Feature Flags table

CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'feature',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "targetType" TEXT,
    "targetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rolloutPercentage" INTEGER,
    "notes" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");
CREATE INDEX "feature_flags_key_idx" ON "feature_flags"("key");
CREATE INDEX "feature_flags_category_idx" ON "feature_flags"("category");
CREATE INDEX "feature_flags_enabled_idx" ON "feature_flags"("enabled");
