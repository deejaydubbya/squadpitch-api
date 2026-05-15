-- SquadInbox channel abstraction.
--
-- Two new enums + four nullable columns wired in additively:
--   ConversationProvider — per-network origin (SQUADSITES, EMAIL,
--                          SMS, FACEBOOK, INSTAGRAM, ...). Drives
--                          the reply-action resolver.
--   MessageVisibility    — PUBLIC / PRIVATE / INTERNAL framing for
--                          channel-aware composer rendering AND
--                          AI prompt filtering.
--
-- All defaults match current production behavior, so existing rows
-- are safe without a hand-written backfill:
--   - Every existing Conversation rows became from FormSubmission
--     intake → provider = SQUADSITES (the column default).
--   - Every existing Message is between CONTACT and WORKSPACE in a
--     private SquadInbox thread → visibility = PRIVATE (default).
-- We still emit explicit UPDATEs below for two specific cases:
--   1. Conversation.sourceType = EMAIL_REPLY → provider = EMAIL
--      (these came from the Postmark inbound webhook, not a form).
--   2. Message.party = SYSTEM → visibility = INTERNAL (audit rows
--      shouldn't be treated as part of the lead conversation).

-- ── Enums ──────────────────────────────────────────────────────────────

CREATE TYPE "ConversationProvider" AS ENUM (
  'SQUADSITES',
  'EMAIL',
  'SMS',
  'FACEBOOK',
  'INSTAGRAM',
  'GOOGLE_BUSINESS',
  'YOUTUBE',
  'LINKEDIN',
  'X',
  'TIKTOK',
  'THREADS',
  'PINTEREST',
  'WEB_CHAT',
  'MANUAL'
);

CREATE TYPE "MessageVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'INTERNAL');

-- ── Conversation columns ───────────────────────────────────────────────

ALTER TABLE "conversations"
  ADD COLUMN "provider"         "ConversationProvider" NOT NULL DEFAULT 'SQUADSITES',
  ADD COLUMN "externalThreadId" TEXT;

-- EMAIL_REPLY conversations (created by the Postmark inbound webhook
-- when there's no existing thread to attach to) come from EMAIL,
-- not the standard SquadSites form path.
UPDATE "conversations"
   SET "provider" = 'EMAIL'
 WHERE "sourceType" = 'EMAIL_REPLY';

-- ── Message columns ────────────────────────────────────────────────────

ALTER TABLE "messages"
  ADD COLUMN "visibility" "MessageVisibility" NOT NULL DEFAULT 'PRIVATE',
  ADD COLUMN "sourceUrl"  TEXT;

-- SYSTEM party rows are workspace-only audit messages — never part
-- of the lead-visible thread, so they're INTERNAL not PRIVATE.
UPDATE "messages"
   SET "visibility" = 'INTERNAL'
 WHERE "party" = 'SYSTEM';

-- ── Indexes ────────────────────────────────────────────────────────────

CREATE INDEX "conversations_clientId_provider_lastMessageAt_idx"
  ON "conversations" ("clientId", "provider", "lastMessageAt");
