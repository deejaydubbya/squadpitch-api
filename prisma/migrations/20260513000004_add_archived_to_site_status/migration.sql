-- Add ARCHIVED to the SiteStatus + PageStatus enums.
--
-- The SquadSites MVP spec (plan 02) lists ARCHIVED as a fourth
-- state for soft-removed pages — keep history, hide from default
-- views. Distinct from UNPUBLISHED (temporarily hidden, can be
-- republished without losing draft history).
--
-- Postgres's `ALTER TYPE ... ADD VALUE` is safe + non-blocking
-- since it only appends to the enum's value list. The
-- `IF NOT EXISTS` guard makes the migration idempotent if Fly's
-- release_command retries.

ALTER TYPE "SiteStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
ALTER TYPE "PageStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
