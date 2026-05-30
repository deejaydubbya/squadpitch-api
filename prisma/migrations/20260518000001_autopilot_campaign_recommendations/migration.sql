-- Phase 2 of Autopilot product audit — persist campaign
-- recommendations with a NEEDS_REVIEW/DISMISSED/etc lifecycle.
-- See docs/AUTOPILOT_PRODUCT_AUDIT.md.

CREATE TYPE "AutopilotTriggerType" AS ENUM (
  'NEW_LISTING',
  'PRICE_DROP',
  'OPEN_HOUSE',
  'JUST_SOLD',
  'STALE_LISTING',
  'NEW_REVIEW',
  'MARKET_UPDATE',
  'SEASONAL',
  'INACTIVITY_GAP'
);

CREATE TYPE "AutopilotRecommendationStatus" AS ENUM (
  'NEEDS_REVIEW',
  'DRAFT_GENERATED',
  'APPROVED',
  'SCHEDULED',
  'DISMISSED',
  'EXPIRED'
);

CREATE TABLE "autopilot_campaign_recommendations" (
  "id"                  TEXT NOT NULL,
  "clientId"            TEXT NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  "expiresAt"           TIMESTAMP(3),
  "triggerType"         "AutopilotTriggerType" NOT NULL,
  "triggerObjectType"   TEXT,
  "triggerObjectId"     TEXT,
  "status"              "AutopilotRecommendationStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "headline"            TEXT NOT NULL,
  "whatWeNoticed"       TEXT NOT NULL,
  "whyItMatters"        TEXT NOT NULL,
  "recommendedChannels" TEXT[],
  "recommendedAngles"   JSONB NOT NULL,
  "generatedDraftIds"   TEXT[],
  "dismissedReason"     TEXT,
  "decidedBy"           TEXT,
  "payloadJson"         JSONB,

  CONSTRAINT "autopilot_campaign_recommendations_pkey" PRIMARY KEY ("id")
);

-- Idempotency — one row per (workspace, triggerType, triggerObjectId).
-- Postgres treats two NULLs as distinct by default, which is what we
-- want: triggers without a specific object (INACTIVITY_GAP) can
-- still collide only when the application catches it (the service
-- layer's findFirst+create dance handles that single case).
CREATE UNIQUE INDEX "uniq_rec_per_trigger_object"
  ON "autopilot_campaign_recommendations" ("clientId", "triggerType", "triggerObjectId");

CREATE INDEX "autopilot_campaign_recommendations_clientId_status_createdAt_idx"
  ON "autopilot_campaign_recommendations" ("clientId", "status", "createdAt");

CREATE INDEX "autopilot_campaign_recommendations_expiresAt_idx"
  ON "autopilot_campaign_recommendations" ("expiresAt");

ALTER TABLE "autopilot_campaign_recommendations"
  ADD CONSTRAINT "autopilot_campaign_recommendations_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
