-- Phase 2 multilingual support — allow English and Spanish SitePage
-- siblings to share the same `slug` within a workspace. Today only
-- (clientId, slug) is unique, which prevents the bilingual sibling
-- pattern where /spring-open-house (en) and /es/spring-open-house
-- (es) both resolve to a row with slug = "spring-open-house".
--
-- The new compound unique is a strict superset of the old one for
-- workspaces whose rows are all `language = "en"` (the Phase 0
-- column default), so existing rows stay valid without backfill.

ALTER TABLE "site_pages"
  DROP CONSTRAINT IF EXISTS "site_pages_clientId_slug_key";

DROP INDEX IF EXISTS "site_pages_clientId_slug_key";

ALTER TABLE "site_pages"
  ADD CONSTRAINT "site_pages_clientId_slug_language_key"
  UNIQUE ("clientId", "slug", "language");
