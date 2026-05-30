# Google Business Profile reviews — implementation checklist

_Status as of 2026-05-16. Source of truth for code:_
- _`domains/inbox/inbox.gbp.ingestion.service.js` — persistence layer (shipped in spinstr11)_
- _`domains/inbox/providerCapabilities.js` — `GOOGLE_BUSINESS` entry_

GBP reviews surface in SquadInbox the same way the Postmark email
flow does: events arrive (here via polling, not webhook), get
normalized, and `ingestGbpReview()` persists them as
`Conversation { provider: GOOGLE_BUSINESS, sourceType: REVIEW }`
+ `Message { visibility: PUBLIC, externalMessageId: <review.name> }`.

This doc tracks **what's already in place** vs **what's still
blocking production**.

---

## ✅ Already shipped (spinstr11 — safe stubs)

- **Schema**: `Conversation.sourceType` enum gained `REVIEW` (additive migration).
- **Ingestion service**: `ingestGbpReview(normalizedReview)` writes Conversation + Contact + Message rows, idempotent on `Message.externalMessageId`. Tenant-resolved via `ChannelConnection` lookup by `channel=GOOGLE_BUSINESS_PROFILE` + `externalAccountId=<location resource name>`. Returns `UNKNOWN_ACCOUNT` for unmatched locations.
- **Reviewer Contact model**: identified by `Contact.enrichmentJson.externalIds.GOOGLE_BUSINESS`, `email=null`, `phone=null` (Reviews API never surfaces those). Anonymous "A Google User" reviewers get a stable synthetic id.
- **Body rendering**: star prefix (`★★★★☆`) + comment, or `★★★★★ (no comment)` for star-only reviews.
- **AI reply prompt**: `review_reply` channel framing — appreciative for positive reviews, calm/solution-oriented for negative, hard rule against echoing PII, hard rule against restating the star rating.
- **Resolver**: `REPLY_REVIEW` already returns `available: false` with reason "Pending Meta App Review for additional scopes (https://www.googleapis.com/auth/business.manage)" (the resolver pulls missing-scopes from `providerCapabilities`).
- **UI badge**: list rows for `provider=GOOGLE_BUSINESS` conversations render an amber **"Google review"** chip distinct from the pink "Facebook" / "Instagram" social chips.
- **Settings → Channels tile**: "Coming soon" GBP tile with `business.manage` approval copy (spinstr411).
- **Admin test injector**: `POST /api/v1/workspaces/:id/inbox/_test/gbp-review` — workspace-owner-gated route that wraps `ingestGbpReview()` for end-to-end UI testing without needing the Google polling adapter live. Mirrors `scripts/test-meta-inbox-webhook.js` but in-process.

### Test the in-process flow today

After connecting a `ChannelConnection { channel: "GOOGLE_BUSINESS_PROFILE", externalAccountId: "<your-location-name>", status: "CONNECTED" }` row to your workspace (via the future OAuth flow, or via direct DB insert for testing):

```bash
curl -X POST 'https://squadpitch-api.fly.dev/api/v1/workspaces/<your-clientId>/inbox/_test/gbp-review' \
  -H "Authorization: Bearer <your JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "locationName": "accounts/100/locations/200",
    "starRating": 5,
    "comment": "Great service!",
    "reviewerName": "Test Reviewer",
    "sourceUrl": "https://search.google.com/local/reviews?..."
  }'
```

Conversation appears in Inbox with the "Google review" badge.

---

## ❌ Still blocking production

### 1. Google OAuth client + verification (4-6 weeks)

- Create a new OAuth client in the existing Google Cloud project (or a new one) with the redirect URI `https://app.squadpitch.com/oauth/GOOGLE_BUSINESS_PROFILE/callback`.
- Add `https://www.googleapis.com/auth/business.manage` to the consent screen scope list.
- **Google sensitive-scope verification** required:
  - Public homepage with privacy policy URL.
  - Privacy policy MUST explicitly mention `business.manage` data use.
  - Short walkthrough video (~2 minutes) showing the data being requested + how it's used.
  - Allow 4-6 weeks for Google to review.
- New env vars (`GOOGLE_BUSINESS_CLIENT_ID`, `_SECRET`, `_REDIRECT_URI`) + Fly secrets.

### 2. OAuth flow + token storage

Implement `domains/studio/oauth/googleBusinessProfile.oauth.js` mirroring `youtube.oauth.js`:

- Exchange auth code → access + refresh tokens.
- Fetch `accounts.list` → user's GBP accounts.
- Per account, fetch `accounts/{a}/locations.list` → list of locations the user manages.
- **Page-picker UI** required: most users manage multiple locations (chain businesses). Without a picker the OAuth flow would have to auto-select pages[0] — same bug the FB flow has today.
- Per selected location, store a `ChannelConnection { channel: GOOGLE_BUSINESS_PROFILE, externalAccountId: "accounts/{a}/locations/{l}", accessToken, refreshToken, scopes: ["business.manage"] }`.

### 3. Reviews polling worker

GBP has no webhook for reviews — polling only. Implement `domains/inbox/providers/gbp.reviewPoller.js`:

- BullMQ cron job, every 5-10 minutes per connected location (start conservative).
- For each `ChannelConnection { channel: GOOGLE_BUSINESS_PROFILE, status: CONNECTED }`:
  - Refresh access token if `tokenExpiresAt` is past skew window (use existing `tokenRefreshService`).
  - `GET accounts/{a}/locations/{l}/reviews?pageSize=50&orderBy=updateTime desc`
  - Track `lastPolledReviewName` per connection (new column on `ChannelConnection`, or in a separate `GbpPollerCursor` table) — early-out when we hit a review we've already seen.
  - For each new review: normalize to the shape `ingestGbpReview()` expects, call it.
  - Handle 429s with `Retry-After`; back off.

### 4. Reply send path

When `business.manage` scope is granted, wire `REPLY_REVIEW`:

- New service `domains/inbox/inbox.outbound.gbp.service.js` mirroring `inbox.outbound.email.service.js`:
  - Take a `conversationId` + reply text.
  - Load the conversation; verify provider=GOOGLE_BUSINESS, message.externalMessageId is set.
  - `PUT accounts/{a}/locations/{l}/reviews/{r}/reply` with body `{ comment }`.
  - On success: write a Message `{ party: WORKSPACE, visibility: PUBLIC, body, externalMessageId: <updated review name>, deliveryStatus: SENT }`.
  - On error: same `FAILED + errorReason + Retry` UX as the email service.
  - **Idempotency**: GBP's `reviews.updateReply` is idempotent itself (one reply per review), but we still want the per-click UUID header same as `sendInboxEmail` to dedupe accidental double-clicks before they hit Google.
- Route: `POST /api/v1/workspaces/:id/inbox/conversations/:conversationId/reply-review`.
- Flip `providerCapabilities.GOOGLE_BUSINESS.sendReview` → `true` once shipped.
- Flip `CHANNEL_META.GOOGLE_BUSINESS_PROFILE.real` → `true` in the web `ChannelConnectionCard` so the tile becomes a real Connect button.

### 5. Resolver flip

When the OAuth flow lands, `getAvailableReplyActions()`'s `REPLY_REVIEW` branch should change from "not connected yet" to:

```js
// Pseudo-code for the future state:
const conn = await getGoogleBusinessConnection({ clientId });
actions.push({
  action: "REPLY_REVIEW",
  available: Boolean(conn && conn.scopes.includes(GBP_BUSINESS_MANAGE_SCOPE)),
  reason: conn ? null : "Connect your Google Business Profile to reply to reviews.",
  requiresConfig: !conn,
});
```

### 6. UI surfaces

- Composer's "Send" button: when `REPLY_REVIEW` is available AND the active conversation is a GBP review, add a fourth tab "Public response" that calls the reply-review endpoint.
- AI panel: pass `channel: "review_reply"` when composer tab is "Public response".
- Conversation detail header: render the star rating prominently (read from `Message.payloadJson.starRating`).

---

## Safety / compliance notes

- **`business.manage` is a sensitive scope.** Google revokes access for misuse. Reply payloads must not include health-disclosure, financial-advice, or PII the reviewer didn't share.
- **24-hour-window-style rules don't apply** to reviews (unlike Meta DMs) — workspaces can reply at any time.
- **Reviewer identity is opaque.** `Contact.enrichmentJson.externalIds.GOOGLE_BUSINESS` is a stable id within one Google account but cannot be cross-referenced to email/phone. Don't try to enrich.
- **Anonymous reviews** ("A Google User") arrive with `isAnonymous: true`. Replies still post, but we use a synthetic Contact id so multiple anon reviews don't all collapse to one Contact row.
- **Tenant isolation:** every ingestion + reply call must scope by `clientId` resolved from the matched `ChannelConnection`, NOT from any field in the payload.

---

## Recommended order for next prompt

Same as spinstr10 for Meta — ship the foundation in three stages:

1. **OAuth + connection** (this is the long pole — wait on Google verification).
2. **Polling worker** (purely additive once the connection exists; can be tested against the production GBP locations the connected user actually has).
3. **Reply send path** (one new endpoint + one new service file; pattern is well-established from `inbox.outbound.email.service.js`).
