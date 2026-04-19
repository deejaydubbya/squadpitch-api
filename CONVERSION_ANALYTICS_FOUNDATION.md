# Conversion Analytics Foundation

## Overview

Lightweight conversion tracking system that measures business outcomes (website clicks, form submissions, calls booked) from social content published through Squadpitch.

## Event Model

A generic `ConversionEvent` model stores all conversion types via a `ConversionEventType` enum:

- **LINK_CLICK** — Auto-logged when a trackable link redirect occurs
- **FORM_SUBMISSION** — Logged via webhook/API when a form is submitted
- **CALL_BOOKED** — Logged when a scheduling link results in a booking
- **CONTACT_CLICK** — Logged when a contact CTA is clicked
- **LISTING_INQUIRY** — Logged when a property listing generates an inquiry
- **CRM_LEAD** — Logged when a CRM integration reports a new lead
- **CUSTOM** — Catch-all for custom conversion events

Each event stores a JSON `metadata` field for type-specific data without schema changes.

## Post-to-Conversion Attribution

Attribution chain: `Draft` → `TrackableLink` → `ConversionEvent`

1. A `TrackableLink` is created for a post (`draftId`) with a unique `shortCode`
2. When someone clicks the link (`/r/:shortCode`), the server:
   - Resolves the shortCode to the TrackableLink
   - Creates a `ConversionEvent` with `type=LINK_CLICK`, copying `clientId` and `draftId` from the link
   - Atomically increments `clickCount` on the TrackableLink
   - Appends UTM params to the destination URL
   - Returns a 302 redirect
3. The ConversionEvent references both `trackableLinkId` and `draftId`, enabling attribution queries like "which posts drove the most conversions"

Privacy: IP addresses and User-Agent strings are SHA-256 hashed before storage — no raw PII is stored.

## Trackable Links

- Short codes are 8-character base64url tokens (48 bits of entropy)
- Redirect URL format: `{API_URL}/r/{shortCode}`
- UTM parameters (source, medium, campaign, term, content) are stored on the link and appended to the destination URL at redirect time
- Rate limited to 60 redirects/min per IP

## Analytics Integration

The `getConversionsSection()` function aggregates conversion data and is included in the analytics overview response under `sections.conversions`. This provides:

- Total conversion count and rate (conversions per published post)
- Active trackable link count
- Breakdown by type (link clicks, form submissions, etc.)
- Breakdown by channel (which social platforms drive conversions)
- Top converting posts (which posts generate the most conversions)

## API Endpoints

### Public (no auth)
- `GET /r/:shortCode` — Redirect endpoint (rate limited)

### Authenticated (requireClientOwner)
- `POST /api/v1/workspaces/:id/links` — Create trackable link
- `GET /api/v1/workspaces/:id/links` — List links (optional `?draftId=` filter)
- `DELETE /api/v1/workspaces/:id/links/:linkId` — Delete link
- `POST /api/v1/workspaces/:id/conversions` — Log conversion event
- `GET /api/v1/workspaces/:id/conversions` — List conversion events

## Extension Points

1. **CRM Webhooks** — External CRMs can POST to `/workspaces/:id/conversions` with `type=CRM_LEAD` to log leads attributed to social content
2. **UTM Auto-population** — When creating a trackable link for a draft, UTM params can be auto-filled from the draft's channel and campaign metadata
3. **JS Tracking Snippet** — A future embeddable snippet can fire `FORM_SUBMISSION` or `CONTACT_CLICK` events back to the API
4. **Multi-touch Attribution** — The `ipHash` field enables dedup and multi-touch attribution by identifying repeat visitors without storing PII
5. **Conversion Goals** — Future per-workspace conversion targets with progress tracking
