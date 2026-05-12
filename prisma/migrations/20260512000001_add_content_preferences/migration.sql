-- Add the ContentPreferences model as the backing store for the
-- Create Preferences settings page. The TS types and assistant
-- consumer (lib/assistant/contentPreferences.ts) already exist;
-- this migration + the matching service/route close the loop.
--
-- Strings rather than enums for the discriminated-union fields
-- (preferredCtaStyle, preferredCampaignCadence, etc.) so adding new
-- option values stays a code-only change and doesn't require a DB
-- migration each time the assistant gains a new cadence or campaign
-- type.
CREATE TABLE "content_preferences" (
    "clientId" TEXT NOT NULL,
    "preferredChannels" "Channel"[] DEFAULT ARRAY[]::"Channel"[],
    "defaultQuickPostChannel" "Channel",
    "preferredTone" TEXT,
    "preferredCtaStyle" TEXT,
    "preferredCampaignCadence" TEXT,
    "defaultCampaignType" TEXT,
    "mediaOrderPreference" TEXT,
    "defaultContentBucket" TEXT,
    "alwaysRequireReview" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerateMedia" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_preferences_pkey" PRIMARY KEY ("clientId")
);

ALTER TABLE "content_preferences" ADD CONSTRAINT "content_preferences_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
