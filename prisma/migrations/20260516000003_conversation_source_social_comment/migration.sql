-- Add SOCIAL_COMMENT to ConversationSource enum.
--
-- Public-comment surface for YouTube (and, when LinkedIn
-- Community Management API approval lands, LinkedIn org posts).
-- Distinct from SOCIAL so the UI can label Inbox rows as
-- "YouTube comment" / "Public comment" rather than a generic
-- social chip — and so the AI-reply prompt branches into the
-- safer public-comment voice automatically.
--
-- Pure additive. No existing rows use this value yet; the new
-- YouTube comment ingestion service writes conversations with
-- sourceType=SOCIAL_COMMENT, provider=YOUTUBE, visibility=PUBLIC.

ALTER TYPE "ConversationSource" ADD VALUE 'SOCIAL_COMMENT';
