-- SquadSites Phase B — first-class Site / SitePage / LeadForm /
-- FormSubmission models. Additive migration; no existing rows
-- affected. The dashboard page builder (Phase C) and the public
-- runtime fetch path both consume these tables.
--
-- Constraint note: form submissions live in their own table;
-- there is intentionally NO Conversation / Inbox model in this
-- migration. The Inbox surface is a separate later phase.

CREATE TYPE "SiteStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');
CREATE TYPE "PageStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');
CREATE TYPE "SubmissionStatus" AS ENUM ('NEW', 'PROCESSED', 'SPAM');

-- ── sites ────────────────────────────────────────────────────────────
-- MVP: one Site per workspace. The UNIQUE constraint on clientId
-- enforces that; multi-site comes in a later phase.
CREATE TABLE "sites" (
  "id"               TEXT NOT NULL,
  "clientId"         TEXT NOT NULL,
  "status"           "SiteStatus" NOT NULL DEFAULT 'DRAFT',
  "themeJson"        JSONB,
  "faviconUrl"       TEXT,
  "ogDefaultImageId" TEXT,
  "createdBy"        TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sites_clientId_key" ON "sites"("clientId");
CREATE INDEX "sites_clientId_status_idx" ON "sites"("clientId", "status");
ALTER TABLE "sites" ADD CONSTRAINT "sites_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── site_pages ──────────────────────────────────────────────────────
-- clientId is denormalized for fast public lookup (resolve endpoint
-- joins on clientId + slug, no Site join needed). campaignId is
-- the cross-module hook into the first-class Campaign model
-- (already in prod). Slug is unique per client.
CREATE TABLE "site_pages" (
  "id"             TEXT NOT NULL,
  "siteId"         TEXT NOT NULL,
  "clientId"       TEXT NOT NULL,
  "slug"           TEXT NOT NULL,
  "campaignId"     TEXT,
  "title"          TEXT NOT NULL,
  "description"    TEXT,
  "status"         "PageStatus" NOT NULL DEFAULT 'DRAFT',
  "blocksJson"     JSONB NOT NULL,
  "heroImageId"    TEXT,
  "seoTitle"       TEXT,
  "seoDescription" TEXT,
  "ogImageId"      TEXT,
  "revalidateSec"  INTEGER NOT NULL DEFAULT 60,
  "publishedAt"    TIMESTAMP(3),
  "createdBy"      TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_pages_clientId_slug_key" ON "site_pages"("clientId", "slug");
CREATE INDEX "site_pages_clientId_status_idx" ON "site_pages"("clientId", "status");
CREATE INDEX "site_pages_campaignId_idx" ON "site_pages"("campaignId");
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "sites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── lead_forms ──────────────────────────────────────────────────────
CREATE TABLE "lead_forms" (
  "id"            TEXT NOT NULL,
  "siteId"        TEXT NOT NULL,
  "clientId"      TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "fieldsJson"    JSONB NOT NULL,
  "successAction" JSONB NOT NULL,
  "notifyEmail"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lead_forms_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lead_forms_clientId_idx" ON "lead_forms"("clientId");
ALTER TABLE "lead_forms" ADD CONSTRAINT "lead_forms_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "sites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── form_submissions ────────────────────────────────────────────────
-- ipHash stores SHA-256(ip + RUNTIME_IP_SALT); the raw IP is
-- never persisted. contactEmail/contactPhone are extracted from
-- dataJson at intake time for query speed.
CREATE TABLE "form_submissions" (
  "id"           TEXT NOT NULL,
  "formId"       TEXT NOT NULL,
  "clientId"     TEXT NOT NULL,
  "campaignId"   TEXT,
  "pageId"       TEXT,
  "dataJson"     JSONB NOT NULL,
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  "ipHash"       TEXT,
  "userAgent"    TEXT,
  "referer"      TEXT,
  "status"       "SubmissionStatus" NOT NULL DEFAULT 'NEW',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "form_submissions_clientId_status_idx" ON "form_submissions"("clientId", "status");
CREATE INDEX "form_submissions_formId_createdAt_idx" ON "form_submissions"("formId", "createdAt");
CREATE INDEX "form_submissions_campaignId_idx" ON "form_submissions"("campaignId");
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_formId_fkey"
  FOREIGN KEY ("formId") REFERENCES "lead_forms"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
