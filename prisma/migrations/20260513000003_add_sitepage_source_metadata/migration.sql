-- SquadSites source-aware metadata. Adds:
--   - SiteSourceType + SitePageGoal enums
--   - SitePage.sourceType, .sourceId, .pageGoal (all nullable)
--   - SitePage.noIndex BOOLEAN DEFAULT FALSE
--   - composite index on (sourceType, sourceId) for reverse-lookup
--     ("what pages reference this campaign / property / etc.")
--
-- Backfill: any SitePage with a non-null campaignId gets
-- sourceType=CAMPAIGN + sourceId=campaignId. Idempotent on re-run
-- via the `sourceType IS NULL` guard, so safe if Fly's
-- release_command retries.
--
-- No data risk: every added column is nullable or has a default.

-- ── Enums ───────────────────────────────────────────────────────────
CREATE TYPE "SiteSourceType" AS ENUM ('CAMPAIGN', 'PROPERTY', 'DATA_ITEM', 'IDEA');
CREATE TYPE "SitePageGoal"   AS ENUM ('LEAD_CAPTURE', 'LISTING', 'OFFER', 'EVENT', 'CONSULTATION');

-- ── Columns ─────────────────────────────────────────────────────────
ALTER TABLE "site_pages"
  ADD COLUMN "sourceType" "SiteSourceType",
  ADD COLUMN "sourceId"   TEXT,
  ADD COLUMN "pageGoal"   "SitePageGoal",
  ADD COLUMN "noIndex"    BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Index ───────────────────────────────────────────────────────────
CREATE INDEX "site_pages_sourceType_sourceId_idx"
  ON "site_pages" ("sourceType", "sourceId");

-- ── Backfill from existing campaignId values ────────────────────────
-- Only touches rows that haven't been classified yet, so the
-- migration is a no-op on re-application.
UPDATE "site_pages"
   SET "sourceType" = 'CAMPAIGN',
       "sourceId"   = "campaignId"
 WHERE "campaignId" IS NOT NULL
   AND "sourceType" IS NULL;
