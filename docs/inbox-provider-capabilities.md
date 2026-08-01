# Inbox Provider Capabilities Audit

_Last reviewed: 2026-05-15. Source of truth for code: [`domains/inbox/providerCapabilities.js`](../domains/inbox/providerCapabilities.js)._

This document captures what each connected provider can realistically
do for the Inbox today, what's needed to flip a provider from
log-only to ingestion-only to fully send-capable, and the app-review /
setup work blocking each step.

**Email is the only proven send channel.** Everything else lands in
one of three buckets:

- **Ingestion-only candidate** — events can be pulled in, but the
  workspace user must still send any reply outside Squadpitch
  ("Log external reply").
- **Send-capable candidate** — provider exposes a reply API _and_
  Squadpitch has (or can request) the scope to call it.
- **Log-only** — provider has no usable third-party API for that
  surface; nothing to wire.

---

## 1. Provider matrix

| Provider | Current connection in Squadpitch | Ingest comments | Ingest DMs | Ingest reviews | Public reply | DM reply | Review reply | Transport |
|---|---|---|---|---|---|---|---|---|
| **Email (Postmark)** | Live | — | ✅ proven | — | — | ✅ proven | — | webhook |
| **SquadSites form** | Live | — | ✅ proven | — | — | — | — | internal |
| **SMS (Twilio)** | env wired, no adapter | — | candidate | — | — | candidate | — | webhook |
| **Facebook Page** | Publish only | scope missing | scope missing | n/a (Recs) | scope missing | scope missing | — | webhook + polling |
| **Instagram (Business)** | Publish + insights | scope missing | scope missing | — | scope missing | scope missing | — | webhook + polling |
| **Google Business Profile** | Not connected | — | — | candidate | — | — | candidate | polling |
| **YouTube** | Publish only | scope sufficient (polling) | n/a | — | scope missing | — | — | polling |
| **LinkedIn (org)** | Publish + read | scope sufficient | n/a | — | scope sufficient | — | — | polling |
| **LinkedIn (personal)** | Publish only | n/a | n/a | — | n/a | n/a | — | none |
| **X (Twitter)** | Publish only | tier-gated | scope missing | — | scope sufficient | scope missing | — | polling |
| **TikTok** | Publish only | no API | no API | — | no API | no API | — | none |
| **Threads** | Publish + reply scopes | scope sufficient | n/a | — | scope sufficient | — | — | webhook |
| **Pinterest** | Publish only | scope missing | n/a | — | scope missing | — | — | none |
| **Reddit** | Not connected | — | — | — | — | — | — | n/a |

Legend: ✅ = wired and proven; **candidate** = API exists, code work
required; **scope sufficient** = Squadpitch already requests what's
needed; **scope missing** = future app-review submission required;
**tier-gated** = provider requires a paid plan; **n/a** = API doesn't
exist for that surface.

---

## 2. Per-provider deep dive

### Email (Postmark) — proven ✅

- **Outbound:** `sendInboxEmail()` in `domains/inbox/inbox.outbound.email.service.js` — central verified Squadpitch Postmark sender. RFC threading + idempotency + retry + auditable Message rows. Provider-aware `availableReplyActions` is authoritative; social conversations do not gain email merely because a contact email exists.
- **Inbound:** `processInboundEmail()` in `domains/inbox/inbox.inbound.email.service.js` — Postmark inbound webhook keyed off `reply+<conversationId>@<INBOX_EMAIL_REPLY_DOMAIN>`.
- **Closed conversations reopen** on inbound reply (unless spam); SYSTEM audit message records the event.
- **Open items:** Postmark account approval, sender verification, and a controlled non-customer delivery must each be recorded explicitly. Gmail/Microsoft connected-mailbox sending is not implemented or required for controlled beta.

---

### SMS (Twilio) — env-only, no adapter

- **Code state:** `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` exist in `config/env.js`. No outbound service, no inbound webhook route.
- **Outbound API:** Twilio Programmable Messaging — single POST.
- **Inbound:** Twilio inbound-SMS webhook → would route to a new `/api/v1/webhooks/twilio/inbound` mirroring the Postmark webhook.
- **Punch list:**
  - [ ] Implement `domains/inbox/inbox.outbound.sms.service.js` mirroring the email service shape.
  - [ ] Implement `domains/inbox/inbox.inbound.sms.service.js` + secret-verified webhook route.
  - [ ] **A2P 10DLC registration** required by US carriers before any production send (Twilio's setup flow). Allow several business days for approval.
  - [ ] STOP / HELP keyword handling — Twilio handles per-number opt-outs automatically, but Inbox should mark the contact `status=ARCHIVED` (or new `OPTED_OUT`) on the inbound STOP webhook.

---

### Facebook Page — publish only

- **Current scopes** (`domains/studio/oauth/facebook.oauth.js`): `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, `read_insights`.
- **Why ingestion isn't wired:** the read-engagement scope returns aggregated insights, not the individual comments/messages. Inbox needs the user-content scope for comment bodies and `pages_messaging` for DMs.
- **Punch list (Meta App Review):**
  - [ ] Add to the in-flight Meta App Review submission:
    - `pages_read_user_content` — comment + reaction bodies.
    - `pages_manage_engagement` — reply / hide / delete comments.
    - `pages_messaging` — DM read + send. **24-hour response window rule** applies after a user message.
    - `pages_messaging_subscriptions` — DM webhook subscription.
  - [ ] Subscribe Page webhooks to `feed` (comments) and `messages` events in Meta App Dashboard.
  - [ ] Implement `domains/inbox/providers/facebook.ingestion.service.js` — handle Page webhook payloads; extract comment body, parent post, commenter info; create Conversation with `provider=FACEBOOK`, `externalThreadId=<post_id>`, Message with `externalMessageId=<comment_id>`, `sourceUrl=<post permalink>`, `visibility=PUBLIC`.
  - [ ] **Reviewer screencast:** Meta App Review requires a 2-3 minute video showing the comment + DM ingestion + reply flow end-to-end. Capture against the demo workspace.

---

### Instagram (Business) — publish + insights

- **Current scopes** (`instagram.oauth.js`): `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `business_management`.
- **Punch list:**
  - [ ] Add to the same Meta App Review submission as Facebook above:
    - `instagram_manage_comments` — read + reply to IG post comments.
    - `instagram_manage_messages` — IG Direct DMs (same 24-hour rule).
  - [ ] IG comments + DMs flow through Meta's webhook system (the same one as FB) — reuse the webhook ingestion service with a per-source dispatcher.
  - [ ] Note: IG live/story DMs have separate echo behavior — `is_echo` filter on the webhook payload to avoid re-ingesting our own outbound.

---

### Google Business Profile — not connected

- **Code state:** _no_ OAuth client, no env vars, no adapter. `GOOGLE_BUSINESS` exists in the `ConversationProvider` enum as a placeholder but has no code path.
- **Why this is recommended next (after email):**
  - Reviews are a high-value Inbox surface and don't have the 24-hour-window complication.
  - GBP Messages API was deprecated 2024 — there's nothing to maintain there long-term.
- **Punch list:**
  - [ ] Add Google OAuth client to GCP project with the sensitive scope `https://www.googleapis.com/auth/business.manage`.
  - [ ] **Google sensitive-scope verification:** Google requires the OAuth consent screen to be verified for any sensitive scope. Submission involves a homepage privacy-policy + scope justification + video demo. Allow 4-6 weeks.
  - [ ] Add `GOOGLE_BUSINESS_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` env. Implement `domains/studio/oauth/googleBusiness.oauth.js`.
  - [ ] Implement polling loop (`domains/inbox/providers/gbp.review.poller.js`) calling `accounts.locations.reviews.list` on a configurable interval (every 5 min).
  - [ ] Map review → Conversation: `provider=GOOGLE_BUSINESS`, Message `body=<review.comment>`, `payloadJson={stars, reviewer.displayName, ...}`, `visibility=PUBLIC`, `sourceUrl=<review.name>`.
  - [ ] Wire `REPLY_REVIEW` action → `accounts.locations.reviews.updateReply`.

---

### YouTube — publish only

- **Current scopes** (`youtube.oauth.js`): `youtube.upload`, `youtube.readonly`.
- **What's possible today:** comment-read via `commentThreads.list` is already authorized by `youtube.readonly`. Inbox could ingest comments without a new scope — only the polling + mapping code is missing.
- **What's needed for reply:**
  - [ ] `https://www.googleapis.com/auth/youtube.force-ssl` (sensitive scope — same verification process as GBP).
- **Webhook posture:** YouTube does NOT offer webhooks for comments (PubSubHubbub covers new videos only). Polling is mandatory.
- **Punch list:**
  - [ ] Decide polling cadence — once per channel every 5-10 min is usually safe under quota.
  - [ ] Add `youtube.force-ssl` to the OAuth scope set + submit for Google verification.
  - [ ] Implement `domains/inbox/providers/youtube.comment.poller.js`.
  - [ ] Map comment → Conversation grouped by `videoId` as `externalThreadId`.

---

### LinkedIn (organization) — publish + read

- **Current scopes** (`linkedinOrg.oauth.js`): `r_organization_admin`, `w_organization_social`, `r_organization_social`.
- **Notable:** the org scope set is _already sufficient_ for ingesting comments on org posts (`socialActions.list`) and replying as the organization (`socialActions.comments.create`).
- **Webhook posture:** LinkedIn doesn't offer organization webhooks for comments. Polling required.
- **Punch list:**
  - [ ] Polling adapter — list recent org `ugcPost`s, poll `socialActions/{shareUrn}/comments` for each.
  - [ ] Rate-limit handling: LinkedIn returns 429 with `Retry-After` headers; existing tokenRefreshService pattern is a good template.
  - [ ] Map comment → Conversation `provider=LINKEDIN_ORG`, Message `visibility=PUBLIC`, `externalMessageId=<commentUrn>`.

---

### LinkedIn (personal) — defer indefinitely

LinkedIn's partner API for personal feeds doesn't expose comment ingestion at the granularity Inbox needs. Defer.

---

### X (Twitter) — publish only, tier-gated

- **Current scopes** (`x.oauth.js`): `tweet.write`, `tweet.read`, `users.read`, `offline.access`.
- **Free tier limits:** 50 read requests / 24h per user; mentions endpoint is gated to higher tiers in practice.
- **Webhook posture:** Account Activity API requires Enterprise tier.
- **Punch list:** Defer until usage justifies a paid X tier. If a customer asks specifically, we can add a polling adapter at Basic tier ($200/mo) — risky given X's API policy churn.

---

### TikTok — publish only

- **API state:** TikTok has no public comment or DM APIs for third parties. Inbox cannot ingest TikTok engagement.
- **Punch list:** None. Document as publish-only.

---

### Threads — publish-only today, but well-positioned

- **Current scopes** (`threads.constants.js → THREADS_SCOPES`): `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_manage_replies`, `threads_read_replies`.
- **Notable:** `threads_manage_replies` + `threads_read_replies` are already in the scope set. Inbox-side adapter is the only thing missing.
- **Webhook posture:** Threads webhook supports `THREADS_REPLIES` events.
- **Punch list:**
  - [ ] Subscribe Threads webhook for `THREADS_REPLIES` in Meta App Dashboard.
  - [ ] Implement `domains/inbox/providers/threads.ingestion.service.js` — analogous to the Postmark inbound webhook shape.
  - [ ] Wire `REPLY_PUBLIC_COMMENT` action → Threads reply endpoint.

---

### Pinterest — publish only

- **Current scopes:** `user_accounts:read`, `boards:read`, `boards:write`, `pins:read`, `pins:write`.
- **Pin comments** would require `pin_comment:read` / `pin_comment:write` — additional Pinterest review.
- **Punch list:** Defer. Pin comments are low-volume engagement for the customer profiles Squadpitch targets.

---

### Reddit / others — not connected

No OAuth client, no env vars. Out of scope.

---

## 3. Recommended implementation order

This matches `RECOMMENDED_ORDER` in `providerCapabilities.js`. The
ordering is driven by (a) value to the workspace user, (b) provider
review friction, and (c) reuse of existing webhook plumbing.

1. **Email (`EMAIL`)** — shipped ✅
2. **Google Business Profile reviews (`GOOGLE_BUSINESS`)** — reviews-only surface, no DM-window complication. Largest upfront cost is Google sensitive-scope verification, but it pays off immediately.
3. **Facebook Page comments (`FACEBOOK`)** — adds three scopes to the in-flight Meta submission. Subscribes the Page webhook.
4. **Instagram comments (`INSTAGRAM`)** — same Meta submission + same webhook plumbing as FB.
5. **Facebook / Instagram DMs** — defer until comments are operating cleanly. DMs carry an extra 24-hour-window rule and bring a separate Meta App Review milestone.
6. **YouTube comments (`YOUTUBE`)** — polling-only. Read works today; reply needs `youtube.force-ssl` + Google verification.
7. **LinkedIn organization comments (`LINKEDIN_ORG`)** — scopes already correct. Polling + rate-limit handling left to build.
8. **SMS (`SMS`)** — Twilio + A2P 10DLC. Useful but not a social surface.
9. **Threads replies (`THREADS`)** — low-volume but cheap (scopes ready, webhook plumbing reusable).
10. **X, TikTok, Pinterest, Reddit, personal LinkedIn** — defer indefinitely.

---

## 4. UI contract

The UI's "Send email" / "Send SMS" / "Reply to comment" affordances
are driven by [`inbox.replyActions.js → getAvailableReplyActions()`](../domains/inbox/inbox.replyActions.js).
Today the resolver hard-codes per-provider rules in
`PROVIDER_CAPABILITIES`. The medium-term plan is to migrate that
inline table to read from `providerCapabilities.js`, so changing a
provider's status in one place updates the UI everywhere.

Until then, the rule of thumb when wiring a new send path:

1. Add the env / scope wiring.
2. Update `domains/inbox/providerCapabilities.js` (this file's code
   sibling) to reflect what's now possible.
3. Update `inbox.replyActions.js` so the resolver flips the action
   to `available: true` only when its specific gate passes.
4. Add a fixture test in `tests/inboxReplyActions.test.js` covering
   the new available-true case.
5. Add a focused integration test for the new send path itself.

This keeps the UI's chip copy honest and prevents a misleading send
button from ever appearing.

---

## 5. Safety / compliance notes

- **24-hour response window** for Meta Page Messaging + IG Direct.
  Outbound DMs after that window require a Message Tag (e.g.
  `HUMAN_AGENT`) or a Sponsored Message. Inbox should track the
  last inbound timestamp per DM thread and surface the window in
  the UI.
- **A2P 10DLC** is mandatory for US Twilio SMS — without it Twilio
  silently rate-limits or filters. Carriers have begun rejecting
  unregistered traffic outright.
- **Google sensitive-scope verification** (business.manage, youtube.force-ssl)
  requires a public homepage with a privacy policy URL that
  explicitly mentions the scope's data use.
- **Never auto-send AI replies.** This is a project-wide invariant
  — every send path must be triggered by an explicit workspace-user
  action.
- **Tenant isolation:** every ingestion adapter must scope writes
  by `clientId` resolved from the connection that fired the
  webhook, NOT from any field in the inbound payload.
