-- Phase 5 of Autopilot product audit — run history.
-- See docs/AUTOPILOT_PRODUCT_AUDIT.md.

CREATE TYPE "AutopilotRunSource" AS ENUM ('MANUAL', 'SCHEDULED', 'EVENT');

CREATE TYPE "AutopilotRunStatus" AS ENUM (
  'CREATED_RECOMMENDATIONS',
  'UPDATED_RECOMMENDATIONS',
  'NO_ACTION',
  'SKIPPED',
  'ERROR'
);

CREATE TABLE "autopilot_runs" (
  "id"                     TEXT NOT NULL,
  "clientId"               TEXT NOT NULL,
  "triggerSource"          "AutopilotRunSource" NOT NULL,
  "status"                 "AutopilotRunStatus" NOT NULL,
  "reason"                 TEXT,
  "recommendationsCreated" INTEGER NOT NULL DEFAULT 0,
  "recommendationsUpdated" INTEGER NOT NULL DEFAULT 0,
  "recommendationsExpired" INTEGER NOT NULL DEFAULT 0,
  "settingsSnapshot"       JSONB,
  "readinessSnapshot"      JSONB,
  "startedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"             TIMESTAMP(3),
  "errorMessage"           TEXT,
  "metadata"               JSONB,

  CONSTRAINT "autopilot_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "autopilot_runs_clientId_startedAt_idx"
  ON "autopilot_runs" ("clientId", "startedAt");

CREATE INDEX "autopilot_runs_startedAt_idx"
  ON "autopilot_runs" ("startedAt");

ALTER TABLE "autopilot_runs"
  ADD CONSTRAINT "autopilot_runs_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
