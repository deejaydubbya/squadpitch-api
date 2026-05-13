-- Campaign model promotion (suite foundation, Phase 1-3).
--
-- Promotes Campaign from an implicit grouping reconstructed from
-- Draft.campaignId/Name/Type into a real first-class entity so
-- SquadSites, SquadAds, and SquadInbox can attach to the same
-- campaign row cleanly.
--
-- This migration is purely additive:
--   - New CampaignStatus enum.
--   - New `campaigns` table.
--   - No FK constraint on drafts.campaignId yet — that lands in a
--     follow-up migration after production backfill is verified.
--   - Draft schema is unchanged in this migration.
CREATE TYPE "CampaignStatus" AS ENUM (
  'DRAFT',
  'PENDING_REVIEW',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'ARCHIVED',
  'FAILED'
);

-- The `id` column has no DEFAULT because backfill INSERTs the
-- existing Draft.campaignId string verbatim (e.g.
-- "camp_1759939200000_a3b9z2"). New campaigns created via
-- save-drafts supply a cuid explicitly from application code.
-- Both formats coexist in the column — it's just TEXT.
CREATE TABLE "campaigns" (
  "id"                TEXT NOT NULL,
  "clientId"          TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "campaignType"      TEXT NOT NULL,
  "sourceType"        TEXT,
  "sourceDataItemId"  TEXT,
  "sourceTitle"       TEXT,
  "campaignIdea"      TEXT,
  "status"            "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "startsAt"          TIMESTAMP(3),
  "endsAt"            TIMESTAMP(3),
  "metadataJson"      JSONB,
  -- Nullable: old data may not have a known creator. Backfill
  -- best-efforts firstDraft.createdBy but won't fail on missing.
  "createdBy"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_sourceDataItemId_fkey"
  FOREIGN KEY ("sourceDataItemId") REFERENCES "workspace_data_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "campaigns_clientId_status_idx" ON "campaigns"("clientId", "status");
CREATE INDEX "campaigns_clientId_createdAt_idx" ON "campaigns"("clientId", "createdAt");
CREATE INDEX "campaigns_sourceDataItemId_idx" ON "campaigns"("sourceDataItemId");
