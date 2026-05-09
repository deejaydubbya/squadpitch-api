-- Add LINKEDIN_ORGANIZATION_PAGE to the Channel enum.
--
-- Existing rows with channel = 'LINKEDIN' are intentionally left as-is —
-- they represent personal-profile connections under the original LinkedIn
-- app and continue to publish through the existing flow. The new value
-- is for connections that authenticate against the Community Management
-- API app and publish to a LinkedIn Organization Page.
ALTER TYPE "Channel" ADD VALUE 'LINKEDIN_ORGANIZATION_PAGE';
