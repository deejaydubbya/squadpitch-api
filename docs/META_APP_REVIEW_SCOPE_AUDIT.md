# Meta App Review — Scope & Feature Audit

> Run date: **2026-05-30**
> Repos audited: `squadpitch-api`, `squadpitch-web`
> Pre-conditions: Prompts IG-01..06 shipped (Instagram Business Login migration), Prompt 05 shipped (Facebook scope completion).

---

## 1. Executive Summary

**Status: READY for the App Review video (after the staging env / Meta App Dashboard checklist in § 6).**

All three blockers from the original audit are resolved:

- **§1 RESOLVED** — `domains/inbox/inbox.outbound.facebook.service.js`
  ships the outbound public-comment-reply adapter for Facebook
  Pages, wired into the `/reply` route + the action resolver.
- **§2 RESOLVED** — `domains/inbox/inbox.outbound.instagram.service.js`
  ships the equivalent for Instagram (uses the IG Business Login
  long-lived user token).
- **§3** — still open (FB Page picker UX). NOT review-blocking when
  the reviewer's test account manages only one Page.

OAuth scope arrays, publishing, analytics sync, comment ingestion,
and comment reply are all wired end-to-end for FB + IG + Threads.
Threads reply still gated behind `THREADS_REPLY_ENABLED=false` by
default — flip the env flag for the demo.

---

## 2. Final Requested Permission List

```txt
public_profile

# Facebook Pages
pages_show_list
pages_read_engagement
pages_manage_posts
read_insights
pages_read_user_content
pages_manage_engagement

# Instagram API with Instagram Login / Business Login
instagram_business_basic
instagram_business_content_publish
instagram_business_manage_insights
instagram_business_manage_comments

# Threads
threads_basic
threads_content_publish
threads_manage_insights
threads_read_replies
threads_manage_replies
```

Source of truth in code:
- `domains/studio/oauth/facebook.oauth.js` → `FACEBOOK_SCOPES`
- `domains/studio/oauth/instagram.oauth.js` → `INSTAGRAM_SCOPES`
- `domains/studio/threads.constants.js` → `THREADS_SCOPES`

---

## 3. Permission-by-Permission Coverage Table

| Permission | Platform | Expected Feature | OAuth Request | API Call Site | UI / Demo Surface | Status |
|---|---|---|---|---|---|---|
| `public_profile` | FB | Default Facebook Login identity | `facebook.oauth.js:FACEBOOK_SCOPES` | (default — included in `/me` and `/me/accounts` responses) | Implicit; consent dialog shows it | **PASS** |
| `pages_show_list` | FB | List + pick Page user manages | `facebook.oauth.js:FACEBOOK_SCOPES` | `facebook.oauth.js exchangeCode` `/me/accounts` | OAuth consent + connect flow in `ChannelConnectionCard` | **PASS** |
| `pages_read_engagement` | FB | Page-level analytics | `facebook.oauth.js:FACEBOOK_SCOPES` | `facebook.metrics.js` + `metaAppReviewChecks.service.js` | `/workspaces/[id]/analytics` page + `MetaAppReviewChecksButton` | **PASS** |
| `pages_manage_posts` | FB | Publish to Page | `facebook.oauth.js:FACEBOOK_SCOPES` | `publishing/channelAdapters/facebook.adapter.js` | Planner publish flow + scheduled publish worker | **PASS** |
| `read_insights` | FB | Page + post insights | `facebook.oauth.js:FACEBOOK_SCOPES` | `facebook.metrics.js` + `metaAppReviewChecks.service.js runFacebookPageInsightsCheck` | Analytics page + App Review checks button | **PASS** |
| `pages_read_user_content` | FB | Read public Page comments | `facebook.oauth.js:FACEBOOK_SCOPES` | `inbox.meta.webhook.routes.js` → `inbox.meta.ingestion.service.js ingestPageFeedChange` | Inbox conversation list once `META_INBOX_INGESTION_ENABLED=true` | **NEEDS MANUAL DEMO** — works, gated by env flag |
| `pages_manage_engagement` | FB | Reply to public Page comments | `facebook.oauth.js:FACEBOOK_SCOPES` | `inbox.outbound.facebook.service.js sendFacebookCommentReply` → `POST graph.facebook.com/v19.0/{comment-id}/comments` with the Page access token | Inbox composer Reply button (resolver flips to `available: true` when scope present); route dispatches to FB branch in `inbox.routes.js` | **PASS** — outbound adapter shipped |
| `instagram_business_basic` | IG | Connect IG Business/Creator account directly | `instagram.oauth.js:INSTAGRAM_SCOPES` | `instagram.oauth.js exchangeCode` `/me?fields=id,username,account_type` | OAuth consent → `ChannelConnectionCard` shows `@username` | **PASS** — no `/me/accounts` Page dependency |
| `instagram_business_content_publish` | IG | Publish IG posts/Reels/media | `instagram.oauth.js:INSTAGRAM_SCOPES` | `publishing/channelAdapters/instagram.adapter.js` (2-step container + publish, polls until FINISHED) | Planner publish flow | **PASS** |
| `instagram_business_manage_insights` | IG | IG account + media analytics | `instagram.oauth.js:INSTAGRAM_SCOPES` | `instagram.metrics.js` + `metaAppReviewChecks.service.js runInstagramInsightsCheck` | Analytics page + App Review checks button | **PASS** |
| `instagram_business_manage_comments` | IG | Read + reply to public IG comments | `instagram.oauth.js:INSTAGRAM_SCOPES` | **Read**: `inbox.meta.ingestion.service.js ingestInstagramComment` ✅. **Reply**: `inbox.outbound.instagram.service.js sendInstagramCommentReply` → `POST graph.facebook.com/v19.0/{ig-comment-id}/replies` with the IG Business Login long-lived user token | Read path: Inbox once `META_INBOX_INGESTION_ENABLED=true`. Reply path: Inbox composer Reply button (resolver flips when scope present) | **PASS** — both read + reply adapters shipped |
| `threads_basic` | Threads | Account identity | `threads.constants.js:THREADS_SCOPES` | `threads.oauth.js exchangeCode` | Connect via `ChannelConnectionCard` | **PASS** |
| `threads_content_publish` | Threads | Publish posts | `threads.constants.js:THREADS_SCOPES` | `publishing/channelAdapters/threads.adapter.js` (`/me/threads` + `/me/threads_publish` + polls) | Planner publish flow | **PASS** |
| `threads_manage_insights` | Threads | Sync analytics | `threads.constants.js:THREADS_SCOPES` | `metricsSync/threads.metrics.js` | Analytics page | **PASS** |
| `threads_read_replies` | Threads | Monitor replies | `threads.constants.js:THREADS_SCOPES` | `threadsReplyPoller.service.js` + `inbox.threads.ingestion.service.js` | Inbox conversation list | **PASS** |
| `threads_manage_replies` | Threads | Reply to / manage replies | `threads.constants.js:THREADS_SCOPES` | `inbox.outbound.threads.service.js` | Inbox composer Reply button | **NEEDS MANUAL DEMO** — works, gated by `THREADS_REPLY_ENABLED=false` env flag (kill switch) |

---

## 4. Deprecated Scope Search Results

Repo-wide grep for legacy IG scopes (`instagram_basic`,
`instagram_content_publish`, `instagram_manage_insights`,
`instagram_manage_comments`, `business_management`):

| File | Type | Verdict |
|---|---|---|
| `domains/studio/oauth/instagram.oauth.js` | **0 active references** | PASS — file header comment contrasts old vs new flow only |
| `tests/instagramOauth.test.js` | Asserts old scopes are NOT in `INSTAGRAM_SCOPES` | **SAFE LEGACY REFERENCE** |
| `tests/instagramInboxCapabilities.test.js` | Asserts old scopes are NOT in `providerCapabilities.INSTAGRAM` | **SAFE LEGACY REFERENCE** |
| `tests/facebookOauth.test.js` | Asserts old IG scopes don't leak into `FACEBOOK_SCOPES` | **SAFE LEGACY REFERENCE** |
| `tests/providerCapabilities.test.js` | Pins post-IG-03 shape; explicit comment that old scopes must not appear | **SAFE LEGACY REFERENCE** |
| `tests/metaAppReviewChecksScopes.test.js` | Asserts App Review check reports the new scope, not legacy | **SAFE LEGACY REFERENCE** |
| `tests/metaAppReviewChecks.test.js` | Uses old scope strings as test-fixture input (simulating a stale connection) | **SAFE LEGACY REFERENCE** — tests legacy-token handling |
| `tests/inboxMetaIngestion.test.js` | Uses old scope strings in test fixture (simulating pre-migration connection) | **SAFE LEGACY REFERENCE** |
| `tests/instagramMetrics.test.js` | Comment mentions historic bug | **SAFE LEGACY REFERENCE** |
| `squadpitch-web src/lib/instagramScopes.ts` | `LEGACY_INSTAGRAM_SCOPES` set in `instagramConnectionNeedsReconnect()` — must know old names to flag them | **SAFE LEGACY REFERENCE** |
| `squadpitch-web src/lib/instagramScopes.test.ts` | Asserts pre-connect description has none of the legacy scope names | **SAFE LEGACY REFERENCE** |

**Active code: zero legacy IG scope references in OAuth, publish, metrics, capabilities, or env config.**

---

## 5. Feature Demo Checklist

The 16 reviewer demo steps from the audit prompt, mapped to actual code:

| # | Step | UI Route / Component | Backend Endpoint / Service | Status |
|---|---|---|---|---|
| 1 | Connect Facebook | `/workspaces/[id]/settings/channels` → `ChannelConnectionCard` (FACEBOOK) | `POST /api/v1/workspaces/:id/oauth/FACEBOOK/start` → `facebook.oauth.buildAuthUrl` | ✅ |
| 2 | Select Facebook Page | `facebook.oauth.exchangeCode` picks first Page from `/me/accounts` automatically | n/a (no picker UI today; picks first Page) | ⚠️ Auto-pick (no Page picker UI). Reviewers will see "Page X connected" — they can't choose if they manage multiple |
| 3 | Publish Facebook post | Planner → publish button OR scheduled-publish worker | `publishing/channelAdapters/facebook.adapter.js publishPost` | ✅ |
| 4 | Sync/view Facebook analytics | `/workspaces/[id]/analytics` page + `MetaInsightsSyncButton` + `MetaAppReviewChecksButton` | `metricsSync/facebook.metrics.js` + `metaAppReviewChecks.service.js runFacebookPageInsightsCheck` | ✅ |
| 5 | Ingest/read Facebook comment | Inbox `/workspaces/[id]/inbox` | `inbox.meta.webhook.routes.js` → `inbox.meta.ingestion.service.js ingestPageFeedChange` | ✅ **Needs `META_INBOX_INGESTION_ENABLED=true`** + Page comments webhook subscription on Meta App Dashboard |
| 6 | Reply to Facebook comment | Inbox composer `Composer.tsx` → POST `/api/v1/workspaces/:id/inbox/conversations/:cid/reply` | `inbox.outbound.facebook.service.js sendFacebookCommentReply` | ✅ |
| 7 | Connect Instagram via Business Login | `ChannelConnectionCard` (INSTAGRAM) | `instagram.oauth.buildAuthUrl` → `instagram.com/oauth/authorize` | ✅ direct Instagram Login (not Facebook Login) |
| 8 | Publish Instagram post | Planner → publish | `publishing/channelAdapters/instagram.adapter.js publishPost` | ✅ |
| 9 | Sync/view Instagram analytics | `/workspaces/[id]/analytics` + `MetaAppReviewChecksButton` | `metricsSync/instagram.metrics.js` + `metaAppReviewChecks.service.js runInstagramInsightsCheck` | ✅ |
| 10 | Ingest/read Instagram comment | Inbox | `inbox.meta.ingestion.service.js ingestInstagramComment` | ✅ **Needs `META_INBOX_INGESTION_ENABLED=true`** + Instagram `comments` field subscription on Meta App Dashboard |
| 11 | Reply to Instagram comment | Inbox composer → POST `/api/v1/workspaces/:id/inbox/conversations/:cid/reply` | `inbox.outbound.instagram.service.js sendInstagramCommentReply` | ✅ |
| 12 | Connect Threads | `ChannelConnectionCard` (THREADS) | `threads.oauth.buildAuthUrl` | ✅ |
| 13 | Publish Threads post | Planner | `publishing/channelAdapters/threads.adapter.js` | ✅ |
| 14 | Sync/view Threads analytics | `/workspaces/[id]/analytics` | `metricsSync/threads.metrics.js` | ✅ |
| 15 | Ingest/read Threads reply | Inbox | `threadsReplyPoller.service.js` + `inbox.threads.ingestion.service.js` (15-min poll) | ✅ |
| 16 | Reply/manage Threads reply | Inbox composer Reply tab | `inbox.outbound.threads.service.js` | ⚠️ **Needs `THREADS_REPLY_ENABLED=true`** (env kill switch defaults false) |

---

## 6. Required Env / Flag Checklist Before Recording the Video

Set these on the **staging API** (and matching values on the web app) **before** the App Review video walkthrough:

### Required for OAuth to work at all
| Variable | Repo | Notes |
|---|---|---|
| `META_APP_ID` | api | Facebook Login client id |
| `META_APP_SECRET` | api | Facebook Login client secret |
| `META_OAUTH_REDIRECT_URI` | api | Must match exactly the URI registered on Meta App Dashboard. Derives `/oauth/FACEBOOK/callback` and (via fallback) `/oauth/INSTAGRAM/callback`. |
| `INSTAGRAM_APP_ID` | api | (optional — falls back to `META_APP_ID`) — set if you split IG into its own Meta App |
| `INSTAGRAM_APP_SECRET` | api | (optional fallback) |
| `INSTAGRAM_OAUTH_REDIRECT_URI` | api | (optional fallback) — must point at `/oauth/INSTAGRAM/callback` |
| `THREADS_APP_ID` | api | Threads developer app id (separate from FB/IG app) |
| `THREADS_APP_SECRET` | api |  |
| `THREADS_REDIRECT_URI` | api | `/oauth/THREADS/callback` |
| `OAUTH_STATE_SECRET` | api | HMAC for OAuth state param |
| `TOKEN_ENCRYPTION_KEY` | api | AES-256-GCM key for storing tokens at rest |

### Required for the comment-ingestion demo steps
| Variable | Default | Set To |
|---|---|---|
| `META_INBOX_INGESTION_ENABLED` | `false` | **`true`** — flips the webhook receiver from "200-OK + log only" to actually writing Conversation/Message rows |
| `META_WEBHOOK_VERIFY_TOKEN` | (unset) | A random 32+ char value matching what's pasted into Meta App Dashboard's webhook subscription form |

### Required for the Threads reply demo step
| Variable | Default | Set To |
|---|---|---|
| `THREADS_REPLY_ENABLED` | `false` | **`true`** — flips the Threads reply send path from blocked to live |

### Recommended for a polished reviewer experience
| Variable | Repo | Notes |
|---|---|---|
| `NEXT_PUBLIC_META_APP_REVIEW_DEMO` | web | `=true` exposes the demo banner + the connected-Meta-accounts card on the analytics page |
| `NEXT_PUBLIC_META_APP_REVIEW_TOOLS` | web | `=true` reveals the App Review check button without needing the admin role |

### Meta App Dashboard (out-of-band, set on the Meta side)
- Webhook subscription on the FB App: subscribe to `page` object, `feed` field (catches comments).
- Webhook subscription on the IG App: subscribe to `instagram` object, `comments` field.
- Webhook callback URL: `https://<api-host>/api/v1/webhooks/meta/inbox`.
- Verify token: matches `META_WEBHOOK_VERIFY_TOKEN`.
- Test users: add reviewer Meta accounts under App Roles → Testers (or the app needs to be in Live mode — the dashboard banner in `ChannelConnectionsList` mentions this).

---

## 7. Test Results

**API**: `npm test` → **1,365 / 1,365 passing** (vitest, 112 test files).

Relevant pinning tests for this audit:
- `tests/facebookOauth.test.js` — seven-scope shape, no DM/IG leakage, FB/IG separation
- `tests/instagramOauth.test.js` — four-scope shape, host = instagram.com, no `/me/accounts`
- `tests/instagramRefresh.test.js` — adapter dispatcher routes IG to new adapter; 4xx → reconnect; 429/5xx throw transient
- `tests/instagramInboxCapabilities.test.js` — capability matrix four-scope shape, no DM scopes, resolver "Connect Instagram" copy when no connection
- `tests/providerCapabilities.test.js` — pins FB seven-scope + IG four-scope shapes
- `tests/metaAppReviewChecksScopes.test.js` — App Review check reports `instagram_business_manage_insights`
- **`tests/inboxOutboundFacebook.test.js`** (NEW) — 12 tests: endpoint URL + Page-token payload, `pages_manage_engagement` gating, tenant scoping (cross-workspace → CONVERSATION_NOT_FOUND), Meta error code 10/190 → PROVIDER_FAILED, 5xx → PROVIDER_UNREACHABLE
- **`tests/inboxOutboundInstagram.test.js`** (NEW) — 10 tests: `/replies` endpoint (not `/comments`), IG Business Login token usage, `instagram_business_manage_comments` gating with explicit rejection of the legacy `instagram_manage_comments` scope set, same error classification matrix
- **`tests/inboxReplyActions.test.js`** (UPDATED) — pins the new resolver behavior for FB + IG (Connect / Reconnect copy when no connection or missing scope; `available: true` when scope present)

**Web**: `npx vitest run` → **415 / 415 passing**. `next lint` → exit 0 (pre-existing warnings only). `next build` → exit 0.

No npm `lint` / `build` scripts exist in the API repo — noted in IG-06 verification. CI workflow on the API runs `vitest run`.

---

## 8. Blockers Before Submission

### ✅ Blocker §1 — Facebook comment-reply outbound adapter — RESOLVED

Shipped `domains/inbox/inbox.outbound.facebook.service.js` (~250 LOC,
mirrors `inbox.outbound.youtube.service.js`):

- `sendFacebookCommentReply(clientId, conversationId, userId, { body, idempotencyKey })`
- Resolves FACEBOOK ChannelConnection, validates `status === CONNECTED`
  + `externalAccountId` + `pages_manage_engagement` in scopes.
- Writes Message in `SENDING` state BEFORE the provider call so a
  mid-flight crash still leaves an auditable row.
- `POST https://graph.facebook.com/v19.0/{comment-id}/comments`
  with `message` + the decrypted Page access token.
- Idempotency: same key returns the existing Message instead of
  double-posting.
- Error classification: 4xx (incl. Meta codes 10/190/200/230) →
  `PROVIDER_FAILED 502`; 5xx → `PROVIDER_UNREACHABLE 503`. FAILED
  Message gets the error reason stored for the audit trail.
- Wired into `/reply` route dispatch in `inbox.routes.js` (FB branch).
- Resolver flipped in `inbox.replyActions.js` — when an FB connection
  with `pages_manage_engagement` is loaded into `extras.facebookConnection`,
  `REPLY_PUBLIC_COMMENT.available` is `true`; otherwise returns
  "Connect Facebook" / "Reconnect Facebook" copy with `requiresConfig: true`.

Tests in `tests/inboxOutboundFacebook.test.js` (12 tests) cover
endpoint URL + payload, scope gating, tenant scoping, error
classification.

### ✅ Blocker §2 — Instagram comment-reply outbound adapter — RESOLVED

Shipped `domains/inbox/inbox.outbound.instagram.service.js` (~250 LOC):

- `sendInstagramCommentReply(clientId, conversationId, userId, { body, idempotencyKey })`
- Resolves INSTAGRAM ChannelConnection, validates
  `instagram_business_manage_comments` in scopes (the new Business
  Login scope; rejects connections that only carry legacy `instagram_manage_comments`).
- Token refresh via `ensureValidAccessToken` → routes through
  `instagramRefresh` (`graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`).
- `POST https://graph.facebook.com/v19.0/{ig-comment-id}/replies`
  with `message` + the decrypted long-lived IG user token (NOT a
  Page token). Endpoint stays on `graph.facebook.com` to match
  the existing `instagram.adapter.js` publish/metrics convention;
  `INSTAGRAM_GRAPH_BASE` constant in `meta.constants.js` is the
  one-line swap target if a future runtime test forces the move.
- Same Message lifecycle / idempotency / error classification as FB.
- Wired into `/reply` route dispatch (INSTAGRAM branch).
- Resolver flipped — gates on `instagram_business_manage_comments`
  in the granted scopes; rejects legacy scope sets explicitly.

Tests in `tests/inboxOutboundInstagram.test.js` (10 tests) cover
endpoint URL (`/replies`, not `/comments`), IG Business Login token
usage, scope gating against the NEW scope (with explicit legacy-scope
rejection), tenant scoping, error classification.

### Blocker §3 — Facebook Page picker UI — Still open

**Symptom**: `facebook.oauth.exchangeCode` calls `/me/accounts` and **picks the first Page automatically** (line 130). For reviewers / users who manage multiple Pages, this silently picks the wrong one with no user-facing recourse.

**Fix scope**: Mirror the LinkedIn Org Page picker pattern that already exists.

**Files to create / change**:
1. `domains/studio/oauth/facebook.oauth.js` — change `exchangeCode` to store ALL Pages temporarily on the connection and return a sentinel like LinkedIn does.
2. `domains/studio/studio.routes.js` — add `GET /workspaces/:id/connections/FACEBOOK/pages` + `POST .../pages/select` mirroring the LinkedIn org routes.
3. `squadpitch-web src/components/studio/FacebookPagePicker.tsx` — mirror `LinkedinOrgPicker.tsx`.
4. Tests for both sides.

**This isn't strictly required for the App Review video** if the reviewer's test account only manages one Page — but it's a UX blocker for production and Meta may flag it.

---

## 9. Recommended App Review Video Walkthrough Script

**If shipping with both reply blockers fixed (recommended):**

1. *(Off-camera)* Set Fly secrets per § 6. Flip both `META_INBOX_INGESTION_ENABLED` and `THREADS_REPLY_ENABLED` to true. Confirm the webhook URL on the Meta App Dashboard.
2. Workspace settings → **Channels** → click **Connect Facebook** → consent screen shows the seven FB scopes → confirm. The card now reads "Connected".
3. Composer → **Create a campaign** → write a one-line post → assign to the connected Facebook Page → click **Publish now** → show the new post on facebook.com. **(`pages_manage_posts`)**
4. Navigate to **Analytics** → click **Sync Meta insights** → numbers populate for the Facebook Page metrics. **(`read_insights` + `pages_read_engagement`)**
5. *(Off-camera or pre-staged)* From a second FB account, leave a comment on the published post.
6. Open **Inbox** → the comment shows up as a new conversation. **(`pages_read_user_content`)**
7. In the composer, click **Reply** → type a response → click **Send** → show the reply appearing under the original comment on facebook.com. **(`pages_manage_engagement`)**
8. Repeat steps 2–7 for **Instagram**:
   - Connect → consent screen on **instagram.com** (NOT facebook.com) → four `instagram_business_*` scopes.
   - Publish an image post.
   - Sync IG analytics.
   - Comment from a second account → ingest in Inbox → reply from composer.
9. Repeat the same five operations for **Threads** — connect, publish, sync analytics, monitor a reply, reply back.
10. Final shot: Channels page showing all three providers green; Inbox showing one conversation per platform with successful outbound replies.

**Do NOT demo or mention private DMs.** None of those scopes are requested in this pass.

**If shipping without the reply blockers fixed:**
- Drop steps 7 + step 8's reply portion + step 16-equivalent's reply portion from the script.
- Remove `pages_manage_engagement` and (the reply portion of) `instagram_business_manage_comments` from the submission. Resubmit those two when the outbound adapters land. Submitting them without code that uses them is a Meta App Review red flag.

---

## 10. Audit conclusion

**Ready for the App Review video** once the staging env / Meta App Dashboard checklist in § 6 is set:

- OAuth scope arrays match the spec target exactly for all three platforms.
- Publishing + analytics sync wired end-to-end on FB + IG + Threads.
- Comment ingestion wired for FB (`pages_read_user_content`) and IG (`instagram_business_manage_comments` read half) via the shared Meta webhook receiver.
- **Comment reply wired for FB (`pages_manage_engagement`) and IG (`instagram_business_manage_comments` reply half) via the two new outbound adapters.**
- Threads reply wired (gated by `THREADS_REPLY_ENABLED=false` env kill switch — flip for the demo).
- No private DM scopes requested anywhere.
- No legacy IG scopes in active code; every legacy-scope grep hit is a SAFE LEGACY REFERENCE (test fixture asserting absence, migration note, or reconnect-detector).

**Recommended next move**: set the staging env vars, complete a real end-to-end test against Meta on a single test workspace (the staging verification steps in § 6), record the App Review video using the script in § 9, submit.

**Out-of-scope nice-to-have**: Blocker §3 (FB Page picker UI). Not review-blocking when the reviewer's test account manages only one Page. Address when usage actually warrants multi-Page UX.
