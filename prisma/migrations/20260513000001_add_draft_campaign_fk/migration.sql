-- Phase 4 of Campaign model promotion: add the
-- Draft.campaignId → Campaign.id foreign key.
--
-- Safe to apply because the previous deploy's backfill script
-- (scripts/backfillCampaigns.js, also wired into release_command)
-- created Campaign rows for every distinct existing
-- Draft.campaignId. The most recent production run confirmed
-- "groups=6 inserted=6 skipped=0 errored=0".
--
-- Constraint shape:
--   ON DELETE SET NULL — preserves publishing history if a
--     campaign is later archived or deleted; the draft keeps its
--     campaignName / campaignType denorm so it still displays
--     coherently in the Planner.
--   ON UPDATE CASCADE  — Campaign.id is stable today, but the
--     cascade is cheap insurance.
--   DEFERRABLE INITIALLY DEFERRED — lets save-drafts insert a
--     Campaign row and the Drafts that reference it in the same
--     transaction without worrying about constraint check order.
ALTER TABLE "drafts"
  ADD CONSTRAINT "drafts_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED;
