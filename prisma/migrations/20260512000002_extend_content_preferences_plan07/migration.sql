-- Plan 07: extend ContentPreferences with additional assistant
-- defaults + Scheduling Defaults inputs. All columns are nullable
-- or carry an empty-array default so existing rows stay valid
-- without backfill.
--
-- Free-form TEXT for discriminated-union fields (defaultContentMode,
-- defaultSource, defaultCtaPreference) so adding new option values
-- in the future stays a code-only change. Posting days/goals are
-- TEXT[] for the same reason.
ALTER TABLE "content_preferences"
  ADD COLUMN "defaultContentMode" TEXT,
  ADD COLUMN "defaultSource" TEXT,
  ADD COLUMN "preferredContentGoals" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "defaultCtaPreference" TEXT,
  ADD COLUMN "defaultCtaCustom" TEXT,
  ADD COLUMN "defaultCampaignLength" INTEGER,
  ADD COLUMN "preferredPostingDays" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "preferredPostingTime" TEXT;
