-- Add GOOGLE_BUSINESS_PROFILE to the publishing Channel enum.
--
-- Inbox-only surface (no SquadStudio publish adapter wired) —
-- exists so a ChannelConnection row can be created when OAuth +
-- business.manage scope land. Reviews ingestion + reply ship in a
-- follow-up prompt.
--
-- Pure additive enum value. No existing rows reference it; no
-- backfill required.

ALTER TYPE "Channel" ADD VALUE 'GOOGLE_BUSINESS_PROFILE';
