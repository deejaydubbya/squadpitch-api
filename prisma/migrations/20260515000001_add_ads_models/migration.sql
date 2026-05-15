-- SquadAds MVP foundation — export-only.
--
-- New tables: ad_packages, ad_creatives, ad_audiences, ad_budgets,
-- ad_destinations. New enums: AdObjective, AdPackageStatus,
-- AdSpecialCategory, AdDestinationKind, AdSourceType.
--
-- No data risk: only adds tables. The new MediaAsset relation field
-- (adCreativesAsPrimary) is a Prisma-side back-relation and does
-- not produce SQL.

-- ── Enums ──────────────────────────────────────────────────────────
CREATE TYPE "AdObjective" AS ENUM (
  'AWARENESS',
  'TRAFFIC',
  'LEADS',
  'ENGAGEMENT',
  'EVENT'
);

CREATE TYPE "AdPackageStatus" AS ENUM (
  'DRAFT',
  'READY',
  'EXPORTED',
  'ARCHIVED'
);

CREATE TYPE "AdSpecialCategory" AS ENUM (
  'NONE',
  'HOUSING',
  'EMPLOYMENT',
  'CREDIT',
  'SOCIAL_ISSUES'
);

CREATE TYPE "AdDestinationKind" AS ENUM (
  'SITE_PAGE',
  'EXTERNAL_URL',
  'SOCIAL_PROFILE'
);

CREATE TYPE "AdSourceType" AS ENUM (
  'CAMPAIGN',
  'SITE_PAGE',
  'DRAFT',
  'PROPERTY',
  'CONTENT_ASSET',
  'IDEA'
);

-- ── ad_packages ────────────────────────────────────────────────────
CREATE TABLE "ad_packages" (
  "id"                TEXT NOT NULL,
  "clientId"          TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "objective"         "AdObjective" NOT NULL,
  "status"            "AdPackageStatus" NOT NULL DEFAULT 'DRAFT',
  "specialCategory"   "AdSpecialCategory" NOT NULL DEFAULT 'NONE',
  "sourceType"        "AdSourceType" NOT NULL,
  "sourceId"          TEXT,
  "sourceIdea"        TEXT,
  "generatedByModel"  TEXT,
  "promptTokens"      INTEGER NOT NULL DEFAULT 0,
  "completionTokens"  INTEGER NOT NULL DEFAULT 0,
  "exportsJson"       JSONB NOT NULL DEFAULT '[]',
  "reviewedByUserId"  TEXT,
  "reviewedAt"        TIMESTAMP(3),
  "reviewNotes"       TEXT,
  "metadataJson"      JSONB,
  "createdBy"         TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ad_packages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ad_packages_clientId_status_updatedAt_idx"
  ON "ad_packages"("clientId", "status", "updatedAt");
CREATE INDEX "ad_packages_clientId_sourceType_sourceId_idx"
  ON "ad_packages"("clientId", "sourceType", "sourceId");

ALTER TABLE "ad_packages"
  ADD CONSTRAINT "ad_packages_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ad_creatives ───────────────────────────────────────────────────
CREATE TABLE "ad_creatives" (
  "id"                      TEXT NOT NULL,
  "adPackageId"             TEXT NOT NULL,
  "variantIndex"            INTEGER NOT NULL,
  "channel"                 "Channel",
  "headline"                TEXT NOT NULL,
  "primaryText"             TEXT NOT NULL,
  "description"             TEXT,
  "cta"                     TEXT,
  "primaryAssetId"          TEXT,
  "additionalAssetIdsJson"  JSONB NOT NULL DEFAULT '[]',
  "rationale"               TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ad_creatives_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ad_creatives_adPackageId_variantIndex_key"
  ON "ad_creatives"("adPackageId", "variantIndex");
CREATE INDEX "ad_creatives_adPackageId_idx"
  ON "ad_creatives"("adPackageId");

ALTER TABLE "ad_creatives"
  ADD CONSTRAINT "ad_creatives_adPackageId_fkey"
  FOREIGN KEY ("adPackageId") REFERENCES "ad_packages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_creatives"
  ADD CONSTRAINT "ad_creatives_primaryAssetId_fkey"
  FOREIGN KEY ("primaryAssetId") REFERENCES "media_assets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── ad_audiences ───────────────────────────────────────────────────
CREATE TABLE "ad_audiences" (
  "id"                       TEXT NOT NULL,
  "adPackageId"              TEXT NOT NULL,
  "locationsJson"            JSONB NOT NULL DEFAULT '[]',
  "ageMin"                   INTEGER,
  "ageMax"                   INTEGER,
  "gendersJson"              JSONB NOT NULL DEFAULT '["all"]',
  "interestsJson"            JSONB NOT NULL DEFAULT '[]',
  "customAudienceHintsJson"  JSONB NOT NULL DEFAULT '[]',
  "languagesJson"            JSONB NOT NULL DEFAULT '[]',
  "housingRestricted"        BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ad_audiences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ad_audiences_adPackageId_key"
  ON "ad_audiences"("adPackageId");

ALTER TABLE "ad_audiences"
  ADD CONSTRAINT "ad_audiences_adPackageId_fkey"
  FOREIGN KEY ("adPackageId") REFERENCES "ad_packages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ad_budgets ─────────────────────────────────────────────────────
CREATE TABLE "ad_budgets" (
  "id"                         TEXT NOT NULL,
  "adPackageId"                TEXT NOT NULL,
  "dailyBudgetCents"           INTEGER,
  "totalBudgetCents"           INTEGER,
  "currency"                   TEXT NOT NULL DEFAULT 'USD',
  "durationDays"               INTEGER,
  "startsAt"                   TIMESTAMP(3),
  "endsAt"                     TIMESTAMP(3),
  "suggestedDailyBudgetCents"  INTEGER,
  "suggestedTotalBudgetCents"  INTEGER,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ad_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ad_budgets_adPackageId_key"
  ON "ad_budgets"("adPackageId");

ALTER TABLE "ad_budgets"
  ADD CONSTRAINT "ad_budgets_adPackageId_fkey"
  FOREIGN KEY ("adPackageId") REFERENCES "ad_packages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ad_destinations ────────────────────────────────────────────────
CREATE TABLE "ad_destinations" (
  "id"             TEXT NOT NULL,
  "adPackageId"    TEXT NOT NULL,
  "kind"           "AdDestinationKind" NOT NULL,
  "sitePageId"     TEXT,
  "externalUrl"    TEXT,
  "socialProfile"  TEXT,
  "utmJson"        JSONB,
  "pixelIdsJson"   JSONB NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ad_destinations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ad_destinations_adPackageId_key"
  ON "ad_destinations"("adPackageId");

ALTER TABLE "ad_destinations"
  ADD CONSTRAINT "ad_destinations_adPackageId_fkey"
  FOREIGN KEY ("adPackageId") REFERENCES "ad_packages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
