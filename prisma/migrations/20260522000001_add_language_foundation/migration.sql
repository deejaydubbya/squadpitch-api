-- Phase 0 of multilingual support: store language preferences on
-- the core customer-facing models so future generation code can
-- read them. Phase 0 does NOT change any generation behavior —
-- Phase 1 (prompt 03) wires `language` through promptBuilder /
-- aiGenerationService / inbox.service / sites.generation.service.
--
-- All additions are additive + safe:
--   - NOT NULL columns get a "en" default so existing rows backfill
--     in place.
--   - Nullable columns mean "inherit from a higher-level default".
--
-- See `lib/languages.js` for the supported-language allow-list and
-- `domains/studio/generation/resolveLanguage.js` for the read-time
-- resolution order.

-- ── Workspace-wide content language default ───────────────────────────
ALTER TABLE "clients"
  ADD COLUMN "defaultLanguage" TEXT NOT NULL DEFAULT 'en';

-- ── Per-workspace generation defaults override (nullable so unset
--    means "inherit from clients.defaultLanguage")
ALTER TABLE "content_preferences"
  ADD COLUMN "defaultLanguage" TEXT;

-- ── Campaign-level override
ALTER TABLE "campaigns"
  ADD COLUMN "language" TEXT;

-- ── Records the language a Draft was actually generated in
ALTER TABLE "drafts"
  ADD COLUMN "language" TEXT;

-- ── Per-thread preferred reply language (nullable)
ALTER TABLE "conversations"
  ADD COLUMN "defaultReplyLanguage" TEXT;

-- ── Records the language an AI reply suggestion was generated in
ALTER TABLE "ai_reply_suggestions"
  ADD COLUMN "language" TEXT;

-- ── Per-page language for SitePages + sibling cross-link for the
--    Phase 2 bilingual variants UX. Defaults to "en" so the public
--    resolver always has a value to match.
ALTER TABLE "site_pages"
  ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN "siblingPageId" TEXT;

-- ── Resolver lookup index used by the Phase 2 public-site
--    renderer: findUnique({ where: { siteId, slug, language } }).
CREATE INDEX "site_pages_siteId_slug_language_idx"
  ON "site_pages"("siteId", "slug", "language");
