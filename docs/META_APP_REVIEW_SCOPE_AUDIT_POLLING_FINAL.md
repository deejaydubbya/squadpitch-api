# Meta App Review — Final Scope Audit (Polling-Only)

_Date: 2026-06-02_
_Auditor: Claude Code (Opus 4.7)_
_Spec: `meta-polling-prompts/05-tests-and-scope-audit.md`_
_Repos audited:_
- `D:\repositories\squadpitch\squadpitch-api`
- `D:\repositories\squadpitch\squadpitch-web`

---

## 1. Executive Summary

**Verdict: READY**

Squadpitch is ready to resubmit to Meta App Review. All sixteen requested Meta scopes (Facebook 7, Instagram 4, Threads 5) are wired to live OAuth flows, real backend code paths, demoable UI surfaces, and passing tests. No forbidden DM / Messenger / legacy IG scope appears in any active code path — every forbidden-scope grep hit is either a test asserting absence, a comment documenting the intentional out-of-scope posture, a legacy-detection helper used to prompt reconnect, or a stale planning doc. The Meta inbox webhook receiver was removed in Prompt 01 and replaced by polling (Prompts 02-04); the only `webhook` strings remaining in active Meta code are the deauthorize / data-deletion callbacks Meta requires on its own dashboard, which are signed-request HMAC and ingest no user content. Facebook and Instagram comments can be polled (background worker + manual sync endpoint + per-card UI button) and replied to (both outbound adapters preserved through the migration). Threads polling-and-reply was end-to-end verified live on 2026-06-01. The full API suite (1406 tests across 116 files) and the full web suite (441 tests across 34 files) pass cleanly on this audit run with no flakes — total 1847 passing, 0 failing.

---

## 2. Final Requested Scope List

Sixteen scopes total. `public_profile` is one of the Facebook 7 (Meta's default user-identity scope, required by Facebook Login).

### Facebook (7)
| # | Scope | Source of truth |
|---|---|---|
| 1 | `public_profile` | `FACEBOOK_SCOPES[0]` in `domains/studio/oauth/facebook.oauth.js:56` |
| 2 | `pages_show_list` | `FACEBOOK_SCOPES[1]` |
| 3 | `pages_read_engagement` | `FACEBOOK_SCOPES[2]` |
| 4 | `pages_manage_posts` | `FACEBOOK_SCOPES[3]` |
| 5 | `read_insights` | `FACEBOOK_SCOPES[4]` |
| 6 | `pages_read_user_content` | `FACEBOOK_SCOPES[5]` |
| 7 | `pages_manage_engagement` | `FACEBOOK_SCOPES[6]` |

### Instagram (4)
| # | Scope | Source of truth |
|---|---|---|
| 1 | `instagram_business_basic` | `INSTAGRAM_SCOPES[0]` in `domains/studio/oauth/instagram.oauth.js:32` |
| 2 | `instagram_business_content_publish` | `INSTAGRAM_SCOPES[1]` |
| 3 | `instagram_business_manage_insights` | `INSTAGRAM_SCOPES[2]` |
| 4 | `instagram_business_manage_comments` | `INSTAGRAM_SCOPES[3]` |

### Threads (5)
| # | Scope | Source of truth |
|---|---|---|
| 1 | `threads_basic` | `THREADS_SCOPES[0]` in `domains/studio/threads.constants.js:28` |
| 2 | `threads_content_publish` | `THREADS_SCOPES[1]` |
| 3 | `threads_manage_insights` | `THREADS_SCOPES[2]` |
| 4 | `threads_manage_replies` | `THREADS_SCOPES[3]` |
| 5 | `threads_read_replies` | `THREADS_SCOPES[4]` |

Cross-checks:
- Facebook scope array exactly matches the spec list (7 items, no extras, correct order).
- Instagram scope array exactly matches the spec list (4 items, no Page scopes, all `instagram_business_*`).
- Threads scope array exactly matches the spec list (5 items).
- Instagram OAuth uses `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` / `INSTAGRAM_OAUTH_REDIRECT_URI` with `META_APP_*` legacy fallback for migration convenience (`instagram.oauth.js:56-69`).
- Instagram OAuth includes `force_reauth=true` in the authorize URL (`instagram.oauth.js:150`).
- The Instagram auth URL targets `https://www.instagram.com/oauth/authorize` directly — NOT `facebook.com` (`instagram.oauth.js:41,152`).
- Threads auth URL targets `https://threads.net/oauth/authorize`, token + data calls on `https://graph.threads.net` (`threads.constants.js:21-23`).

---

## 3. Forbidden Scope Verification

Searched both repos for: `pages_messaging`, `pages_messaging_subscriptions`, `instagram_manage_messages`, `instagram_business_manage_messages`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`, `business_management`.

**FAIL count: 0**

| File | Lines | Scope(s) hit | Why it's there | Classification |
|---|---|---|---|---|
| `squadpitch-api/domains/studio/oauth/facebook.oauth.js` | 51-53 | `pages_messaging`, `pages_messaging_subscriptions` | Comment block: "Messenger / DM scopes are intentionally NOT here. We are not requesting Facebook private DMs in this App Review pass." | SAFE LEGACY REFERENCE |
| `squadpitch-api/domains/inbox/providerCapabilities.js` | 96-97, 141 | `pages_messaging`, `pages_messaging_subscriptions`, `instagram_manage_messages` | Comments documenting "out of scope" posture on FACEBOOK and INSTAGRAM capability entries | SAFE LEGACY REFERENCE |
| `squadpitch-api/domains/inbox/inbox.metaCommentIngestion.service.js` | 24 | `pages_messaging`, `instagram_business_manage_messages` | Header comment: "Private DMs explicitly OUT of scope" | SAFE LEGACY REFERENCE |
| `squadpitch-api/domains/inbox/inbox.replyActions.js` | 41 | `instagram_business_manage_messages` | Comment documenting that IG DM scope is NOT requested | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/facebookOauth.test.js` | 52-67, 120 | All 9 forbidden scopes (asserted absent) | Negative-assertion test: `FACEBOOK_SCOPES` must NOT contain any of these | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/instagramOauth.test.js` | 48-53, 92-93 | `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`, `business_management` | Negative-assertion test: `INSTAGRAM_SCOPES` must NOT contain any of these | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/instagramInboxCapabilities.test.js` | 22-54 | DM + legacy IG scopes (asserted absent) | Negative-assertion test | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/providerCapabilities.test.js` | 144, 159, 168, 183-187 | DM + legacy IG scopes (asserted absent) | Negative-assertion test loop | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/inboxOutboundInstagram.test.js` | 5, 146-149 | `instagram_manage_comments` | Test fixture for "legacy connection rejected — needs `instagram_business_manage_comments`" path | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/inboxInstagramCommentPoller.test.js` | 344-351 | `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments` | Test asserting poller REJECTS connections carrying only the legacy IG scope shape | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/inboxReplyActions.test.js` | 704-707 | `instagram_*` legacy | Test fixture | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/instagramMetrics.test.js` | 102 | `instagram_manage_insights` (in comment) | Comment referencing a historical bug ticket | SAFE LEGACY REFERENCE |
| `squadpitch-api/tests/metaAppReviewChecks*.test.js` | 3, 36, 260, 269 | `instagram_manage_insights` | App-review check tool's backward-compat test (legacy name handling) | SAFE LEGACY REFERENCE |
| `squadpitch-api/docs/inbox-provider-capabilities.md` | 77, 82-83, 92, 95-96 | Multiple legacy + DM scopes | Stale planning doc from pre-IG-OAuth-migration era. Not loaded at runtime, not referenced by any active code path. | SAFE LEGACY REFERENCE (recommend deleting post-submission) |
| `squadpitch-api/docs/META_APP_REVIEW_SCOPE_AUDIT.md` | 90-92 | Multiple legacy | Previous audit doc | SAFE LEGACY REFERENCE |
| `squadpitch-api/docs/META_APP_REVIEW_SCOPE_AUDIT_RESUBMISSION.md` | 57-78, etc. | Multiple forbidden | Previous audit doc | SAFE LEGACY REFERENCE |
| `squadpitch-web/src/lib/instagramScopes.ts` | 41-44, 51 | `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`, `business_management` | `LEGACY_INSTAGRAM_SCOPES` Set used by `instagramConnectionNeedsReconnect()` — detects pre-migration connections and triggers the reconnect banner. The set is checked for ABSENCE on new connections, never granted. | SAFE LEGACY REFERENCE |
| `squadpitch-web/src/lib/instagramScopes.test.ts` | 47-52, 98, 117-122 | Multiple legacy | Tests for the reconnect detector | SAFE LEGACY REFERENCE |
| `squadpitch-web/src/components/studio/ChannelConnectionCard.metaSync.test.ts` | 167-174 | `instagram_business_manage_messages`, `pages_messaging`, `pages_messaging_subscriptions`, "private message", "direct message", "DM scope" | Negative-assertion test: card markup must NOT contain any of these | SAFE LEGACY REFERENCE |

**Conclusion: 0 active code-path or live-OAuth uses of any forbidden scope.** Every hit is either an absence-assertion test, an intentional documentation comment, a legacy-detection helper, or a stale doc.

---

## 4. Webhook Removal Verification

**FB/IG inbox webhook dependency: NONE.**

### Searches performed (both repos)
- `META_WEBHOOK_VERIFY_TOKEN` — 0 hits in active env / code. Only hits are: (a) `config/env.js:60` comment block explaining removal, (b) `tests/metaCommentPollerWorker.test.js:194,201` assertion that the env var is NOT exported, (c) the two pre-existing audit docs and the `.env.example` references documenting the removal.
- `META_INBOX_INGESTION_ENABLED` — same: 0 active uses; only the removal-comment and the assertion-of-absence test.
- `/webhooks/meta/inbox` — only hits are `scripts/test-meta-inbox-webhook.js` (a legacy script, retained for history but no longer wired to a live route) and the two old audit docs.
- `inbox.meta.webhook.routes.js` — file **does not exist** (Glob result: no files found).
- `inbox.meta.ingestion.service.js` — file **does not exist** (Glob result: no files found). Functionality was extracted to `inbox.metaCommentIngestion.service.js` (the shared upsert helper) and consumed by the FB + IG comment pollers.

### Active `webhook` references in `domains/inbox/` — classification

| File | What it is | Classification |
|---|---|---|
| `inbox.webhook.routes.js` | Postmark inbound email webhook only (HMAC verified) | SAFE — unrelated provider |
| `inbox.facebookCommentPoller.service.js` | Comment in header documents the webhook receiver was removed | SAFE — documentation comment |
| `inbox.instagramCommentPoller.service.js` | Same as above | SAFE — documentation comment |
| `inbox.metaCommentIngestion.service.js` | Same as above | SAFE — documentation comment |
| `providerCapabilities.js` | Sets `webhooks: false` on FACEBOOK + INSTAGRAM rows | SAFE — declarative metadata, correct value |
| `inbox.routes.js`, `inbox.outbound.email.service.js`, `inbox.inbound.email.service.js`, `inbox.outbound.sms.service.js` | Postmark / Twilio webhook handling | SAFE — unrelated provider (email, SMS) |
| `youtubeCommentPoller.service.js`, `gbpReviewPoller.service.js`, `threadsReplyPoller.service.js` | Comments noting no webhook is available, so poller exists | SAFE — unrelated polling code |

### Other webhook routers wired in `server.js`
| Mount | Purpose | Classification |
|---|---|---|
| `metaThreadsWebhookRouter` → `/api/webhooks/meta/threads/{deauthorize,data-deletion}` | Meta-required app-lifecycle callbacks (signed_request HMAC). Ingest no comments/messages. | SAFE — required by Meta dashboard, unrelated to inbox content |
| `inboxWebhookRouter` → `/api/v1/webhooks/postmark/inbound` | Postmark inbound emails | SAFE — unrelated provider |
| `webhookRouter` → `/api/v1/integrations/webhooks` | Admin-side OUTBOUND webhook delivery feature (lets a workspace forward Squadpitch events to their own URL) | SAFE — unrelated user-facing feature |
| `app.use("/api/v1/billing/webhook", express.raw())` | Stripe webhook | SAFE — unrelated provider |

**Conclusion: zero webhook dependency for FB or IG inbox.** Comment ingestion is entirely polling-based (background worker + manual sync endpoint). The webhook strings that remain are all either documentation, absence-assertions, or unrelated providers (Stripe, Postmark, Twilio, Meta Threads lifecycle callbacks, GBP/YouTube polling fallbacks, the admin outbound-webhooks integration).

---

## 5. Permission-by-Permission Coverage Table

| # | Scope | Platform | Feature | OAuth requested? | Backend code path exists? | UI / demo surface | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | `public_profile` | FB | Identity (required by Facebook Login default) | YES (`facebook.oauth.js:56`) | YES — `exchangeCode()` resolves identity via Facebook Login session | Channel Connection card → "Connect Facebook" button | `tests/facebookOauth.test.js` | PASS |
| 2 | `pages_show_list` | FB | Page selection during connect | YES (`facebook.oauth.js:57`) | YES — `GET /me/accounts` (`facebook.oauth.js:148`) | Page is auto-picked (first Page); name shown on card after connect | `tests/facebookOauth.test.js` | PASS |
| 3 | `pages_read_engagement` | FB | Page-level engagement metrics + comment-poller gate | YES (`facebook.oauth.js:58`) | YES — `facebook.metrics.js`; required by `inbox.facebookCommentPoller.service.js:61` | Analytics tab; comment poller | `tests/facebookMetrics.test.js`, `tests/inboxFacebookCommentPoller.test.js` | PASS |
| 4 | `pages_manage_posts` | FB | Publish Page posts | YES (`facebook.oauth.js:59`) | YES — `facebook.adapter.js` publish path | Studio → Publish FB post | `tests/facebookAdapter.test.js`, `tests/publishingService.test.js` | PASS |
| 5 | `read_insights` | FB | Page + post insights sync | YES (`facebook.oauth.js:60`) | YES — `facebook.metrics.js` | Analytics tab | `tests/facebookMetrics.test.js`, `tests/metricsSync.test.js` | PASS |
| 6 | `pages_read_user_content` | FB | Poll public comments on Page posts | YES (`facebook.oauth.js:61`) | YES — `inbox.facebookCommentPoller.service.js` (scope gate at line 61) | Channel card "Sync comments now" button + Inbox conversation list | `tests/inboxFacebookCommentPoller.test.js`, `tests/inboxFacebookSyncCommentsRoute.test.js` | PASS |
| 7 | `pages_manage_engagement` | FB | Reply to public Page comments from Inbox | YES (`facebook.oauth.js:62`) | YES — `inbox.outbound.facebook.service.js` (scope gate at line 31) | Inbox → conversation → Reply | `tests/inboxOutboundFacebook.test.js` | PASS |
| 8 | `instagram_business_basic` | IG | Identity + connect (Instagram Business Login) | YES (`instagram.oauth.js:32`) | YES — `instagram.oauth.js exchangeCode()`; `GET graph.instagram.com/me` | Channel Connection card → "Connect Instagram" button | `tests/instagramOauth.test.js` | PASS |
| 9 | `instagram_business_content_publish` | IG | Publish IG media (Posts, Reels) | YES (`instagram.oauth.js:33`) | YES — `instagram.adapter.js` publish path | Studio → Publish IG post | `tests/instagramOauth.test.js`, `tests/publishingService.test.js` | PASS |
| 10 | `instagram_business_manage_insights` | IG | IG account + media insights | YES (`instagram.oauth.js:34`) | YES — `instagram.metrics.js` | Analytics tab | `tests/instagramMetrics.test.js`, `tests/metricsSync.test.js` | PASS |
| 11 | `instagram_business_manage_comments` | IG | Poll IG comments + reply to them | YES (`instagram.oauth.js:35`) | YES — `inbox.instagramCommentPoller.service.js` (scope gate at line 63) + `inbox.outbound.instagram.service.js` (scope gate at line 38) | Channel card "Sync comments now" button + Inbox conversation list + Reply | `tests/inboxInstagramCommentPoller.test.js`, `tests/inboxInstagramSyncCommentsRoute.test.js`, `tests/inboxOutboundInstagram.test.js` | PASS |
| 12 | `threads_basic` | Threads | Identity + connect | YES (`threads.constants.js:29`) | YES — `threads.oauth.js exchangeCode()`; `GET graph.threads.net/me` | Channel Connection card → "Connect Threads" button | `tests/threadsOauth.test.js` | PASS |
| 13 | `threads_content_publish` | Threads | Publish Threads posts | YES (`threads.constants.js:30`) | YES — `threadsAdapter.js` publish path (container + polling + publish) | Studio → Publish Threads post | `tests/threadsAdapter.test.js` | PASS |
| 14 | `threads_manage_insights` | Threads | Threads insights | YES (`threads.constants.js:31`) | YES — `threads.metrics.js` | Analytics tab | `tests/threadsMetrics.test.js` | PASS |
| 15 | `threads_read_replies` | Threads | Poll replies on Threads posts | YES (`threads.constants.js:33`) | YES — `threadsReplyPoller.service.js` + `inbox.threads.ingestion.service.js` | Channel card "Sync replies now" button + Inbox conversation list | `tests/inboxThreadsIngestion.test.js` | PASS |
| 16 | `threads_manage_replies` | Threads | Reply to Threads replies from Inbox | YES (`threads.constants.js:32`) | YES — `threadsReplies.service.js` reply send path (gated on `THREADS_REPLY_ENABLED` for staged rollout) | Inbox → conversation → Reply | `tests/threadsAdapter.test.js`, `tests/inboxThreadsIngestion.test.js`; verified live 2026-06-01 | PASS |

All 16 scopes: OAuth ✓ Backend ✓ Demo UI ✓ Tests ✓.

---

## 6. Facebook Polling + Reply Audit

### Polling — `domains/inbox/inbox.facebookCommentPoller.service.js`
- Service exists; orchestrated by `workers/facebookCommentPollerWorker.js`.
- Uses the per-connection FB **Page access token** (decrypted, refreshed via `ensureValidAccessToken`).
- Requires scopes `pages_read_user_content` AND `pages_read_engagement` (`REQUIRED_SCOPES` at line 61); connection is skipped with a clear error if missing.
- Calls `GET ${META_GRAPH_BASE}/{post-id}/comments?fields=id,message,from,created_time,parent,comment_count` (i.e. graph.facebook.com/v19.0).
- Finds published Squadpitch Facebook posts by querying `prisma.draft` for `channel=FACEBOOK` + `externalPostId IS NOT NULL` within `POST_LOOKBACK_DAYS = 30`.
- Creates Inbox `Conversation` and `Message` rows via the shared `upsertExternalCommentMessage` helper in `inbox.metaCommentIngestion.service.js`.
- Dedupes on `Message.externalMessageId = commentId`. Repeated upserts return `{ status: 'duplicate' }`.
- Stores everything needed for reply: `externalThreadId = parentPostId`, `externalMessageId = commentId`, `fromId`, `fromName`, permalink, raw payload.
- 401/403 from Graph → marks connection `NEEDS_RECONNECT` and stops further work on it (avoids hammering with bad token).
- Echo guard: if `from.id === pageId`, skips with reason `ECHO_FROM_PAGE` so the outbound reply we just sent doesn't duplicate-create as an inbound.

### Outbound reply — `domains/inbox/inbox.outbound.facebook.service.js`
- Adapter preserved through the migration (commit `74ad2d9` removed the webhook receiver but kept the reply adapter).
- Requires scope `pages_manage_engagement` on the connection (line 31).
- Uses the **Page access token** (decrypted, refreshed).
- Endpoint: `POST ${META_GRAPH_BASE}/{comment-id}/comments` — i.e. graph.facebook.com/v19.0.
- Works on polling-created Messages because the polling ingester sets `externalMessageId` to the FB comment id, which is exactly the parent the reply adapter posts to.
- Idempotency-key safe: write-SENDING → call → flip-SENT-or-FAILED pattern; `idempotencyKey` enforces single-fire on double-click.

### Manual sync endpoint
- `POST /api/v1/workspaces/:id/connections/FACEBOOK/sync-comments` (`studio.routes.js:4450`).
- Enqueues a one-shot BullMQ job (`enqueueFacebookCommentPollForConnection`); falls back to inline execution if Redis is unavailable in dev.
- NOT gated on `META_COMMENT_POLLING_ENABLED` — always works for ops / demo / dev.
- Returns 202 with `{ status: 'queued', connectionId, message }`.

### UI surface
- `squadpitch-web/src/components/studio/ChannelConnectionCard.tsx:328-348` — FB card renders a "Sync comments now" button when `channel === 'FACEBOOK' && isConnected`.
- Hook: `useSyncFacebookComments(clientId)` (`useSquadpitch.ts:2555`).
- Status text cycles `Syncing…` → `Queued ✓` (success) / inline error banner on failure.

Tests: `inboxFacebookCommentPoller.test.js` (10), `inboxFacebookSyncCommentsRoute.test.js` (7), `inboxOutboundFacebook.test.js` (10), `metaCommentPollerWorker.test.js` (9). All passing.

---

## 7. Instagram Polling + Reply Audit

### Polling — `domains/inbox/inbox.instagramCommentPoller.service.js`
- Service exists; orchestrated by `workers/instagramCommentPollerWorker.js`.
- Uses the per-connection **direct Instagram Business Login user token** (NOT a Facebook Page token). Token is decrypted and refreshed via `ensureValidAccessToken` (which dispatches to `instagramRefresh` → `graph.instagram.com/refresh_access_token`).
- Requires scope `instagram_business_manage_comments` (`REQUIRED_SCOPE` at line 63); connection skipped with clear error if missing.
- **Host correctly set to `INSTAGRAM_GRAPH_BASE` (`https://graph.instagram.com`)** — not `graph.facebook.com`. This is critical: direct IG tokens get "Cannot parse access token" on the FB host. Confirmed correct at `inbox.instagramCommentPoller.service.js:56`. Documented in the file header.
- Calls `GET ${INSTAGRAM_GRAPH_BASE}/{ig-media-id}/comments?fields=id,text,username,timestamp,like_count,from`.
- Finds published Squadpitch IG media by querying `prisma.draft` for `channel=INSTAGRAM` + `externalPostId IS NOT NULL` within 30-day window.
- Creates Inbox `Conversation` and `Message` rows via the shared `upsertExternalCommentMessage`.
- Dedupes on `Message.externalMessageId = commentId`.
- Stores reply-needed metadata: `externalThreadId = mediaId`, `externalMessageId = commentId`, `fromId`, `fromName`, permalink, raw payload.
- 401/403 → `NEEDS_RECONNECT`.
- Echo guard: if `from.id === igUserId`, skips with `ECHO_FROM_ACCOUNT`.
- `MISSING_FROM_ID` skip path for comments where Meta omits the `from` field (sometimes happens — same shape the deleted webhook ingester used).

### Outbound reply — `domains/inbox/inbox.outbound.instagram.service.js`
- Adapter preserved through the migration.
- Requires scope `instagram_business_manage_comments` (line 38).
- Uses the **direct Instagram Business Login user token** (decrypted via `decryptToken(fresh.accessToken)` after refresh).
- **Endpoint: `POST ${INSTAGRAM_GRAPH_BASE}/{ig-comment-id}/replies`** — verified correct at line 227. Critical: this is `graph.instagram.com`, NOT `graph.facebook.com`. The header comment (lines 1-32) explicitly documents the host requirement; the 2026-05-31 publish-path post-mortem is cited inline.
- Works on polling-created Messages because the polling ingester sets `externalMessageId` to the IG comment id, which is the parent the reply endpoint targets.
- Idempotency-key safe.
- After successful send, sets the outbound `Message.externalMessageId = published reply id` so the next poll tick's idempotency check filters out our own outbound reply as a duplicate.

### Manual sync endpoint
- `POST /api/v1/workspaces/:id/connections/INSTAGRAM/sync-comments` (`studio.routes.js:4535`).
- Same shape as FB: enqueue → inline-fallback on Redis-unavailable → 202 with `queued`.
- NOT gated on `META_COMMENT_POLLING_ENABLED`.

### UI surface
- `ChannelConnectionCard.tsx:363-383` — IG card renders a "Sync comments now" button when `channel === 'INSTAGRAM' && isConnected && !instagramNeedsReconnect`. The `!instagramNeedsReconnect` gate is deliberate: if scopes are stale we surface the Reconnect banner instead.
- Hook: `useSyncInstagramComments(clientId)` (`useSquadpitch.ts:2570`).

Tests: `inboxInstagramCommentPoller.test.js` (10), `inboxInstagramSyncCommentsRoute.test.js` (7), `inboxOutboundInstagram.test.js` (8), `instagramInboxCapabilities.test.js` (9), `instagramOauth.test.js` (13), `instagramRefresh.test.js`, `metaCommentPollerWorker.test.js` (9). All passing.

---

## 8. Threads Polling + Reply Audit

### Polling — `domains/inbox/threadsReplyPoller.service.js`
- Service exists; orchestrated by `workers/threadsReplyPollerWorker.js`.
- Uses the per-connection long-lived Threads user token (refreshable via `/refresh_access_token`).
- Requires scope `threads_read_replies`.
- Calls `GET graph.threads.net/{post-id}/conversation` per recently-published Threads post.
- Ingests each reply idempotently via `inbox.threads.ingestion.service.js`.

### Outbound reply — `domains/studio/threadsReplies.service.js`
- Reply publishing requires `threads_manage_replies` (granted).
- Implemented as a new child thread with `replied_to=<id>` on the publish pipeline.
- Resolver gated on `THREADS_REPLY_ENABLED` env flag for staged rollout.

### Manual sync endpoint
- `POST /api/v1/workspaces/:id/connections/THREADS/sync-replies`.

### UI surface
- `ChannelConnectionCard.tsx:293-313` — Threads card renders a "Sync replies now" button when `channel === 'THREADS' && isConnected`.
- Hook: `useSyncThreadsReplies(clientId)`.

### Manual end-to-end test result
**PASS — 2026-06-01.** A comment published from a second account on a SquadPitch-published Threads post appeared in the Inbox after the workspace user clicked "Sync replies now". Reply was sent from the Inbox successfully.

Tests: `threadsOauth.test.js` (4), `threadsMetrics.test.js` (6), `threadsAdapter.test.js` (8), `inboxThreadsIngestion.test.js` (10), `metaThreadsWebhook.test.js` (6 — for the deauthorize/data-deletion callbacks). All passing.

---

## 9. Env / Fly Checklist

### Expected ACTIVE env / secrets (must be set on Fly)
| Var | Source | Notes |
|---|---|---|
| `META_APP_ID` | `config/env.js:41` | Facebook Login app id |
| `META_APP_SECRET` | `config/env.js:42` | |
| `META_OAUTH_REDIRECT_URI` | `config/env.js:43` | |
| `INSTAGRAM_APP_ID` | `config/env.js:52` | Instagram Login app id (may equal `META_APP_ID` during migration; falls back to it) |
| `INSTAGRAM_APP_SECRET` | `config/env.js:53` | Falls back to `META_APP_SECRET` |
| `INSTAGRAM_OAUTH_REDIRECT_URI` | `config/env.js:54` | Falls back to derived URI |
| `THREADS_APP_ID` | env | Separate Meta app for Threads |
| `THREADS_APP_SECRET` | env | |
| `THREADS_REDIRECT_URI` | env | |
| `THREADS_ENABLED=true` | env | Gates whole Threads channel |
| `THREADS_REPLY_ENABLED=true` | env | Required for the demo's Threads reply step (otherwise resolver pins "not enabled") |
| `OAUTH_STATE_SECRET` | `config/env.js:83` | Random 32+ bytes |
| `TOKEN_ENCRYPTION_KEY` | `config/env.js:86` | Base64 32 bytes for AES-256-GCM token-at-rest |
| `META_COMMENT_POLLING_ENABLED=true` | `config/env.js:71` | Turn ON for App Review demo so the recurring 15-min tick runs (manual sync also works regardless) |
| `META_COMMENT_POLLING_INTERVAL_MINUTES=15` | `config/env.js:73` | Default is fine |
| `META_COMMENT_POLLING_LOOKBACK_DAYS=30` | `config/env.js:77` | Default is fine |

### Expected REMOVED env (should NOT be set; presence is harmless but indicates stale config)
| Var | Status |
|---|---|
| `META_WEBHOOK_VERIFY_TOKEN` | REMOVED — `config/env.js:60-63` explains. Asserted absent in `tests/metaCommentPollerWorker.test.js:201`. Safe to delete from Fly secrets. |
| `META_INBOX_INGESTION_ENABLED` | REMOVED — `config/env.js:60-63` explains. Asserted absent in `tests/metaCommentPollerWorker.test.js:202`. Safe to delete from Fly secrets. |

### Meta Dashboard webhook subscriptions
- **FB Page / Instagram product Webhooks subscriptions for COMMENTS are no longer required.** The app does not consume them. Leaving them subscribed on the dashboard is harmless (we'll 200-OK at any inbox endpoint that's still up, but there isn't one for FB/IG comments anymore).
- The deauthorize / data-deletion callbacks at `/api/webhooks/meta/threads/{deauthorize,data-deletion}` are still required by Meta's dashboard for the Threads app and remain configured.

---

## 10. Test Results

### Targeted API tests (in order from spec section 7)

| Command | File | Tests passed | Result |
|---|---|---|---|
| `npx vitest run tests/facebookOauth.test.js` | facebookOauth | 7/7 | PASS |
| `npx vitest run tests/instagramOauth.test.js` | instagramOauth | 13/13 | PASS |
| `npx vitest run tests/providerCapabilities.test.js` | providerCapabilities | 21/21 | PASS |
| `npx vitest run tests/inboxOutboundFacebook.test.js` | inboxOutboundFacebook | 10/10 | PASS |
| `npx vitest run tests/inboxOutboundInstagram.test.js` | inboxOutboundInstagram | 8/8 | PASS |
| `npx vitest run tests/inboxFacebookCommentPoller.test.js` | inboxFacebookCommentPoller | 10/10 | PASS (spec called this `inboxFacebookCommentPolling.test.js`; actual filename is `…Poller.test.js`) |
| `npx vitest run tests/inboxInstagramCommentPoller.test.js` | inboxInstagramCommentPoller | 10/10 | PASS (same filename note) |
| `npx vitest run tests/threads*.test.js` | threadsOauth, threadsMetrics, threadsAdapter, inboxThreadsIngestion, metaThreadsWebhook | 4+6+8+10+6 = 34/34 | PASS |
| `npx vitest run tests/inboxFacebookSyncCommentsRoute.test.js` | inboxFacebookSyncCommentsRoute | 7/7 | PASS |
| `npx vitest run tests/inboxInstagramSyncCommentsRoute.test.js` | inboxInstagramSyncCommentsRoute | 7/7 | PASS |
| `npx vitest run tests/metaCommentPollerWorker.test.js` | metaCommentPollerWorker | 9/9 | PASS |
| `npx vitest run tests/inboxMetaCommentIngestion.test.js` | inboxMetaCommentIngestion | 17/17 | PASS |

### Full API suite — `npm test`
**Test Files: 116 passed (116)**
**Tests: 1406 passed (1406)**
**Duration: ~15 s**
No failures. No skipped tests reported. No autopilot parallelism flake observed on this run.

### Full web suite — `npx vitest run` in `squadpitch-web`
**Test Files: 34 passed (34)**
**Tests: 441 passed (441)**
**Duration: ~2.4 s**
No failures.

### Aggregate
**Total: 1847 / 1847 passing. 0 failures.**

---

## 11. App Review Video Script

This script demonstrates every requested scope through a live UI action.

### Pre-record (off-camera)
- Set Fly secrets per § 9. Set `META_COMMENT_POLLING_ENABLED=true` and `THREADS_REPLY_ENABLED=true`.
- Have **two** real test accounts ready for each platform: the workspace's connected account (the "us" voice) and a second account (the "viewer" voice) that will leave comments / replies.
- Sign in to `app.squadpitch.com` as a workspace owner on a freshly-created workspace. Stay on the Studio page.
- Have the Meta Dashboard tab open in another window for the developer-tools shot (optional).

### Recording — Facebook section

1. Navigate to **Studio → Channels → Channel Connections**.
2. Locate the **Facebook** card. Click **"Connect Facebook"**. (Shows `public_profile`, `pages_show_list` consent.)
3. In the Facebook consent dialog, approve all seven requested scopes: `public_profile`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `pages_read_user_content`, `pages_manage_engagement`. Pick the test Page.
4. Card flips to **Connected** with the Page name and a green status pill.
5. Click **Studio → Posts → New Post**. Compose a short text post, select the Facebook channel, click **Publish now**. Wait for the success toast. (Demonstrates `pages_manage_posts`.)
6. Click **Analytics**. Show that the Facebook tab loads metrics (engagement, reach, impressions). (Demonstrates `pages_read_engagement` + `read_insights`.)
7. Switch to the **second Facebook account** in another browser. Open the published Page post. Leave a comment "Great post!".
8. Switch back to the workspace. Go to **Studio → Channels**. On the Facebook card, click **"Sync comments now"**. Button shows "Syncing…" → "Queued ✓". (Demonstrates `pages_read_user_content` polling.)
9. Click **Inbox** in the left nav. The new conversation appears with the commenter's name and "Great post!". Open it.
10. In the reply composer, type "Thanks!" and click **Send**. Message shows as SENT. (Demonstrates `pages_manage_engagement` outbound reply.)
11. Switch to the second Facebook account, refresh the post — the "Thanks!" reply appears under the original comment.

### Recording — Instagram section

12. Back in Squadpitch, **Studio → Channels**. On the **Instagram** card, click **"Connect Instagram"**.
13. The browser navigates to `instagram.com/oauth/authorize` (note: NOT facebook.com). Approve all four scopes: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`, `instagram_business_manage_comments`. (`force_reauth=true` is in the URL — show the URL bar briefly.)
14. Card flips to **Connected** showing the `@username`.
15. Click **Studio → Posts → New Post**. Compose a post with an image, select the Instagram channel, click **Publish now**. Wait for the success toast. (Demonstrates `instagram_business_content_publish`.)
16. Click **Analytics → Instagram tab**. Show metrics rendering. (Demonstrates `instagram_business_manage_insights`.)
17. Switch to the second Instagram account. Open the published media. Leave a comment "Love it!".
18. Switch back to Squadpitch. **Studio → Channels**. On the Instagram card, click **"Sync comments now"**. "Syncing…" → "Queued ✓". (Demonstrates `instagram_business_manage_comments` — polling read.)
19. Click **Inbox**. The new conversation appears. Open it. Reply "Thank you!". (Demonstrates `instagram_business_manage_comments` — outbound reply via `graph.instagram.com/{comment-id}/replies`.)
20. Switch to the second Instagram account, refresh the post — the reply appears under the original comment.

### Recording — Threads section

21. Back in Squadpitch, **Studio → Channels**. On the **Threads** card, click **"Connect Threads"**.
22. Browser navigates to `threads.net/oauth/authorize`. Approve all five scopes: `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_manage_replies`, `threads_read_replies`.
23. Card flips to **Connected**.
24. **Studio → Posts → New Post**. Compose a text post, select Threads channel, **Publish now**. (Demonstrates `threads_content_publish`.)
25. **Analytics → Threads tab**. Show metrics rendering. (Demonstrates `threads_manage_insights`.)
26. Switch to second Threads account. Open the published thread. Leave a reply "Cool!".
27. Switch back to Squadpitch. **Studio → Channels**. On the Threads card, click **"Sync replies now"**. (Demonstrates `threads_read_replies`.)
28. Click **Inbox**. New conversation appears. Open it. Reply "Thanks for reading!". (Demonstrates `threads_manage_replies`.)
29. Switch to second Threads account, refresh — the reply appears.

### Wrap
- Show **all three** channel cards now displaying "Connected" with sync buttons.
- Show the **Inbox** with three conversations (FB, IG, Threads), each with both the inbound comment and the outbound reply visible.

Total runtime estimate: 6-8 minutes. All 16 scopes exercised through real UI actions and real Graph calls.

---

## 12. Final Recommendation

**SUBMIT NOW.**

All READY criteria are satisfied:
- All 16 requested scopes present in the OAuth flows, in the right provider files, with no extras.
- 0 FAIL-classified forbidden-scope hits in either repo.
- No FB/IG webhook dependency remains for inbox. The Meta webhook receiver was removed in commit `74ad2d9`; ingestion is polling-only.
- Facebook comments: poll path + reply path both working. Tests pass.
- Instagram comments: poll path + reply path both working, both correctly routed through `graph.instagram.com`. Tests pass.
- Threads: poll + reply both working. Manual end-to-end verified 2026-06-01.
- 1847/1847 tests passing across both repos.

Nothing needed fixing during this audit.

### Optional cleanup (post-submission, not blocking)
- Delete the stale planning doc `docs/inbox-provider-capabilities.md` — it predates the IG OAuth migration and references the old scope shape. Not loaded at runtime, but a future grep for legacy scopes will keep hitting it.
- Delete the legacy script `scripts/test-meta-inbox-webhook.js` — it points at an endpoint that no longer exists.
- Once Fly secrets are confirmed clean, remove `META_WEBHOOK_VERIFY_TOKEN` and `META_INBOX_INGESTION_ENABLED` from the Fly app if they're still present (the code already doesn't read them).

---

_End of report._
