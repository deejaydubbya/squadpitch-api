-- Add Client.contactRetentionDays for inbox retention policy
-- documentation. No auto-purge worker — manual purge only via
-- the inbox DELETE endpoint. Nullable so existing workspaces
-- keep indefinite retention until they set a policy explicitly.

ALTER TABLE "clients"
  ADD COLUMN "contactRetentionDays" INTEGER;
