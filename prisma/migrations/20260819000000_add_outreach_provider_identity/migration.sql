ALTER TABLE "agent_discovery_runs"
  ADD COLUMN "agentLinksFound" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "newAgentsCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "suppressedCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "agent_outreach_prospects"
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "providerExternalId" TEXT;

-- Backfill one canonical historical row per Coldwell Banker aid. If legacy
-- duplicates somehow exist, leave later rows provider-null so this additive
-- migration remains deployable; discovery's legacy URL lookup still protects
-- every historical row from retargeting.
WITH candidates AS (
  SELECT "id",
         substring(COALESCE("stableIdentity", "profileUrl") from 'aid_([0-9]+)') AS external_id,
         row_number() OVER (
           PARTITION BY substring(COALESCE("stableIdentity", "profileUrl") from 'aid_([0-9]+)')
           ORDER BY "discoveredAt", "id"
         ) AS identity_rank
  FROM "agent_outreach_prospects"
  WHERE "sourceDomain" ILIKE '%coldwellbankerhomes.com'
    AND COALESCE("stableIdentity", "profileUrl") ~* 'aid_[0-9]+'
)
UPDATE "agent_outreach_prospects" AS prospect
SET "provider" = 'COLDWELL_BANKER_HOMES',
    "providerExternalId" = candidates.external_id
FROM candidates
WHERE prospect."id" = candidates."id"
  AND candidates.identity_rank = 1;

CREATE UNIQUE INDEX "agent_outreach_prospects_provider_providerExternalId_key"
  ON "agent_outreach_prospects"("provider", "providerExternalId");
