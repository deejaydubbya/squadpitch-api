-- Add listing context to the existing canonical outreach template without
-- replacing any other production edits.
UPDATE "outreach_email_templates"
SET
  "textBody" = replace(
    "textBody",
    'Squadpitch helps real estate agents turn listings, open houses, sold properties, and other business updates into ready-to-post social media content using AI.',
    'Squadpitch helps real estate agents turn listings, open houses, sold properties, and other business updates into ready-to-post social media content using AI.' || E'\n\n' || 'I used your listing at {{listing_address}} as a starting point. I found {{listing_count}} active listing(s) for your workspace.'
  ),
  "htmlBody" = replace(
    "htmlBody",
    '<p>Squadpitch helps real estate agents turn listings, open houses, sold properties, and other business updates into ready-to-post social media content using AI.</p>',
    '<p>Squadpitch helps real estate agents turn listings, open houses, sold properties, and other business updates into ready-to-post social media content using AI.</p>' || E'\n  ' || '<p>I used your listing at <strong>{{listing_address}}</strong> as a starting point. I found {{listing_count}} active listing(s) for your workspace.</p>'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'default'
  AND "textBody" NOT LIKE '%{{listing_address}}%';
