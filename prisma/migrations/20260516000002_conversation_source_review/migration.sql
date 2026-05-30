-- Add REVIEW to ConversationSource enum.
--
-- Public-review surface for GBP / Yelp / FB Page Recommendations.
-- Distinct from SOCIAL so the UI can label Inbox rows as
-- "Google review" / "Public response" rather than a generic
-- comment chip.
--
-- Pure additive. No existing rows reference REVIEW yet; the GBP
-- review ingestion service writes new conversations with this
-- value once the OAuth + polling adapter lands.

ALTER TYPE "ConversationSource" ADD VALUE 'REVIEW';
