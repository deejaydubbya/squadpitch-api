-- Replace the singular listing sentence with a complete, readable address list.
UPDATE "outreach_email_templates"
SET
  "textBody" = replace(
    "textBody",
    'I used your listing at {{listing_address}} as a starting point. I found {{listing_count}} active listing(s) for your workspace.',
    'I created sample social content using these active listings:' || E'\n\n' || '{{listing_addresses}}'
  ),
  "htmlBody" = replace(
    "htmlBody",
    '<p>I used your listing at <strong>{{listing_address}}</strong> as a starting point. I found {{listing_count}} active listing(s) for your workspace.</p>',
    '<p>I created sample social content using these active listings:</p>' || E'\n  ' || '<p style="white-space:pre-line;">{{listing_addresses}}</p>'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'default';
