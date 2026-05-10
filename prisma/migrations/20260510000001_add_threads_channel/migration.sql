-- Add Threads (Meta) as a supported social channel.
-- Existing rows are unaffected (nothing was using THREADS in the database
-- before this migration). The OAuth module, publishing adapter, metrics
-- adapter, replies service, and webhook callbacks are added in this same
-- release — see domains/studio/oauth/threads.oauth.js and friends, plus
-- docs/THREADS_SETUP.md.
ALTER TYPE "Channel" ADD VALUE 'THREADS';
