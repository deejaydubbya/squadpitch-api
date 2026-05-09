-- Promote Pinterest from "coming soon" placeholder to a fully-supported channel.
-- Existing rows are unaffected (nothing was using PINTEREST in the database).
-- The connection adapter, OAuth module, and boards picker are added in this
-- same release — see domains/studio/oauth/pinterest.oauth.js and friends.
ALTER TYPE "Channel" ADD VALUE 'PINTEREST';
