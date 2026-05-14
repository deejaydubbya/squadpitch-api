-- SquadInbox MVP foundation.
--
-- New tables: contacts, conversations, messages, conversation_notes,
-- ai_reply_suggestions. New enums: ContactSource, ContactStatus,
-- ConversationSource, ConversationStatus, ConversationParty,
-- MessageChannel.
--
-- Idempotency: conversations.sourceFormSubmissionId is UNIQUE so
-- the inbox intake service can be re-run safely on the same form
-- submission (worker retry, backfill rerun, etc.) without
-- duplicating Conversation rows.
--
-- No data risk: only adds tables. Existing Form / Site / Campaign
-- tables are untouched.

-- ── Enums ──────────────────────────────────────────────────────────
CREATE TYPE "ContactSource" AS ENUM (
  'FORM',
  'IMPORT',
  'MANUAL',
  'SOCIAL',
  'EMAIL_REPLY'
);

CREATE TYPE "ContactStatus" AS ENUM (
  'NEW',
  'ENGAGED',
  'QUALIFIED',
  'CONVERTED',
  'ARCHIVED'
);

CREATE TYPE "ConversationSource" AS ENUM (
  'FORM',
  'SOCIAL',
  'EMAIL_REPLY',
  'MANUAL'
);

CREATE TYPE "ConversationStatus" AS ENUM (
  'OPEN',
  'PENDING',
  'CLOSED',
  'SNOOZED'
);

CREATE TYPE "ConversationParty" AS ENUM (
  'CONTACT',
  'WORKSPACE',
  'SYSTEM'
);

CREATE TYPE "MessageChannel" AS ENUM (
  'FORM_SUBMISSION',
  'EMAIL',
  'SMS',
  'SOCIAL_DM',
  'MANUAL_LOG'
);

-- ── contacts ──────────────────────────────────────────────────────
CREATE TABLE "contacts" (
  "id"                  TEXT NOT NULL,
  "clientId"            TEXT NOT NULL,
  "email"               TEXT,
  "phone"               TEXT,
  "name"                TEXT,
  "firstSeenVia"        "ContactSource" NOT NULL DEFAULT 'FORM',
  "firstSeenFormId"     TEXT,
  "firstSeenPageId"     TEXT,
  "firstSeenCampaignId" TEXT,
  "enrichmentJson"      JSONB,
  "tags"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"              "ContactStatus" NOT NULL DEFAULT 'NEW',
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

CREATE UNIQUE INDEX "contacts_clientId_email_key"
  ON "contacts" ("clientId", "email");
CREATE UNIQUE INDEX "contacts_clientId_phone_key"
  ON "contacts" ("clientId", "phone");
CREATE INDEX "contacts_clientId_status_updatedAt_idx"
  ON "contacts" ("clientId", "status", "updatedAt");

-- ── conversations ────────────────────────────────────────────────
CREATE TABLE "conversations" (
  "id"                     TEXT NOT NULL,
  "clientId"               TEXT NOT NULL,
  "contactId"              TEXT NOT NULL,
  "sourceType"             "ConversationSource" NOT NULL DEFAULT 'FORM',
  "sourceFormSubmissionId" TEXT,
  "pageId"                 TEXT,
  "campaignId"             TEXT,
  "status"                 "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "spam"                   BOOLEAN NOT NULL DEFAULT FALSE,
  "lastMessageAt"          TIMESTAMP(3) NOT NULL,
  "lastMessageFrom"        "ConversationParty" NOT NULL,
  "workspaceReadAt"        TIMESTAMP(3),
  "assignedUserId"         TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "contacts"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- Idempotency key for the intake worker.
CREATE UNIQUE INDEX "conversations_sourceFormSubmissionId_key"
  ON "conversations" ("sourceFormSubmissionId");

CREATE INDEX "conversations_clientId_status_lastMessageAt_idx"
  ON "conversations" ("clientId", "status", "lastMessageAt");
CREATE INDEX "conversations_contactId_idx"
  ON "conversations" ("contactId");
CREATE INDEX "conversations_assignedUserId_idx"
  ON "conversations" ("assignedUserId");

-- ── messages ────────────────────────────────────────────────────
CREATE TABLE "messages" (
  "id"                TEXT NOT NULL,
  "conversationId"    TEXT NOT NULL,
  "party"             "ConversationParty" NOT NULL,
  "channel"           "MessageChannel",
  "body"              TEXT NOT NULL,
  "payloadJson"       JSONB,
  "externalMessageId" TEXT,
  "authorUserId"      TEXT,
  "fromSuggestionId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

CREATE INDEX "messages_conversationId_createdAt_idx"
  ON "messages" ("conversationId", "createdAt");

-- ── conversation_notes ──────────────────────────────────────────
CREATE TABLE "conversation_notes" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "authorUserId"   TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "conversation_notes"
  ADD CONSTRAINT "conversation_notes_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

CREATE INDEX "conversation_notes_conversationId_createdAt_idx"
  ON "conversation_notes" ("conversationId", "createdAt");

-- ── ai_reply_suggestions ────────────────────────────────────────
CREATE TABLE "ai_reply_suggestions" (
  "id"               TEXT NOT NULL,
  "conversationId"   TEXT NOT NULL,
  "forMessageId"     TEXT NOT NULL,
  "body"             TEXT NOT NULL,
  "tone"             TEXT,
  "model"            TEXT NOT NULL,
  "promptTokens"     INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "acceptedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_reply_suggestions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ai_reply_suggestions"
  ADD CONSTRAINT "ai_reply_suggestions_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

CREATE INDEX "ai_reply_suggestions_conversationId_createdAt_idx"
  ON "ai_reply_suggestions" ("conversationId", "createdAt");
