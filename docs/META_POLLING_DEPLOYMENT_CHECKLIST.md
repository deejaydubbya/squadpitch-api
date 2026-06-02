# Meta Polling — Deployment & App Review Checklist

Produced after the webhooks → polling migration (prompts 01–06). Use this checklist before resubmitting Meta App Review and after the polling deploy lands in production.

Companion doc: `META_APP_REVIEW_SCOPE_AUDIT_POLLING_FINAL.md` (the READY/NOT READY verdict).

---

## 1. Fly secrets — cleanup commands

The following Fly secrets are no longer referenced by application code and should be unset. Code paths that depended on them were deleted in commits `74ad2d9` (prompt 01) and `1ecb469` (prompt 03).

```sh
fly secrets list -a squadpitch-api | grep -E 'META_WEBHOOK_VERIFY_TOKEN|META_INBOX_INGESTION_ENABLED'
# if either is present:
fly secrets unset META_WEBHOOK_VERIFY_TOKEN -a squadpitch-api
fly secrets unset META_INBOX_INGESTION_ENABLED -a squadpitch-api
```

Unsetting is optional — they're inert if left in place — but removing them keeps the secret list honest and prevents anyone from re-introducing webhook code on the assumption that the env is wired.

---

## 2. Fly secrets — required active set

```sh
fly secrets list -a squadpitch-api
```

Confirm these are all present (values are NOT printed — `fly secrets list` only shows names + creation timestamps):

**Facebook (OAuth):**
- `META_APP_ID`
- `META_APP_SECRET`
- `META_OAUTH_REDIRECT_URI`

**Instagram (Business Login — own dedicated Meta App):**
- `INSTAGRAM_APP_ID`
- `INSTAGRAM_APP_SECRET`
- `INSTAGRAM_OAUTH_REDIRECT_URI`

**Threads:**
- `THREADS_APP_ID`
- `THREADS_APP_SECRET`
- `THREADS_REDIRECT_URI`
- `THREADS_REPLY_ENABLED=true` (if still feature-flagged in your boot path)

**Shared:**
- `OAUTH_STATE_SECRET`
- `TOKEN_ENCRYPTION_KEY`

If any are missing, the channel they belong to will fail at the OAuth boundary with a typed error (`INSTAGRAM_NOT_CONFIGURED`, `META_NOT_CONFIGURED`, etc.). See `config/env.js` for the boot-time warnings.

---

## 3. Optional polling secrets (scheduler activation)

The manual `POST /api/v1/workspaces/:id/connections/{FACEBOOK,INSTAGRAM}/sync-comments` endpoints **always work** without these — they're for activating the every-15-minute background scheduler.

```sh
# Activate scheduled FB + IG comment polling on the same cadence as Threads:
fly secrets set META_COMMENT_POLLING_ENABLED=true -a squadpitch-api
# Optional overrides (defaults: 15 minutes, 30-day lookback):
fly secrets set META_COMMENT_POLLING_INTERVAL_MINUTES=15 -a squadpitch-api
fly secrets set META_COMMENT_POLLING_LOOKBACK_DAYS=30 -a squadpitch-api
```

Setting any secret triggers a rolling restart. Verify the worker boot lines after:

```sh
fly logs -a squadpitch-api | grep -E "FB_COMMENT_POLLER|IG_COMMENT_POLLER|TH_REPLY_POLLER"
```

Expect three healthy `started` log lines on the worker machine — one per provider.

---

## 4. Web env (Vercel/Fly — whichever hosts `squadpitch-web`)

No new web env vars were required by the polling migration. Optional demo flags if you want to surface additional review-only copy (none currently rendered):

- `NEXT_PUBLIC_META_APP_REVIEW_DEMO=true` — reserved for future review-only banners; per-card Sync buttons render unconditionally for the workspace owner so no flag is needed for the basic demo flow.

---

## 5. Meta App Dashboard cleanup

**Webhook subscriptions can be removed.** The FB Page-feed and IG `comments` webhook subscriptions are no longer needed — the application no longer accepts webhook deliveries for inbox ingestion.

In the dashboard for each app (`976330011625092` = Facebook Login app; `1623901772159307` = dedicated IG Business Login app):

- **Facebook Webhooks → Page → unsubscribe `feed`** (optional, but cleaner)
- **Instagram Webhooks → Instagram → unsubscribe `comments`** (optional)
- The webhook callback URL pointing at `/api/v1/webhooks/meta/inbox` will 404 if anything still tries to deliver to it — that's expected and harmless.

**Scopes — DO NOT REMOVE.** The polling implementation still requires the full scope set because the Graph API enforces the same permissions whether you read via webhook delivery or polling:

- `pages_read_user_content` (FB comment polling)
- `pages_read_engagement` (FB comment polling, supplementary)
- `pages_manage_engagement` (FB outbound reply)
- `instagram_business_manage_comments` (IG comment polling + outbound reply)

Keep submitting all 16 scopes for App Review (7 FB + 4 IG + 5 Threads).

**Forbidden:** Do not subscribe to or request any DM scope. `pages_messaging`, `pages_messaging_subscriptions`, `instagram_business_manage_messages` are all explicitly out-of-scope for this submission.

---

## 6. App Review video — final shooting script

Each segment should be 30–60 seconds; the whole video can stay under 5 minutes. Use a clean test workspace, ideally with a second IG/FB account on hand for cross-account commenting.

### Segment A — Facebook (Page publishing + comment loop + reply)
1. Sign in to SquadPitch → workspace → Settings → Channels.
2. Click **Connect** on the Facebook card → grant the 7 scopes (`public_profile` + 6 Page scopes) in the popup.
3. Show the connected card with status pill = CONNECTED.
4. Go to Studio → Compose → channel: Facebook → publish a post.
5. Switch to facebook.com → open the published post on the Page.
6. (Optional) From a second FB account, leave a comment on the post.
7. Back in SquadPitch → Settings → Channels → click **Sync comments now** on the Facebook card. Expect "Queued ✓".
8. Wait ~10 seconds → open SquadInbox → the new comment appears as a FACEBOOK conversation.
9. Click reply → type a response → send. Expect the message status to flip to SENT.
10. Switch back to facebook.com → refresh the post → show the reply live.

### Segment B — Instagram (Business Login publishing + comment loop + reply)
1. Settings → Channels → click **Connect** on the Instagram card → grant the 4 `instagram_business_*` scopes via Instagram's own consent dialog (the URL bar will show `instagram.com/oauth/authorize?...force_reauth=true`, never `/third_party/`).
2. Show CONNECTED status.
3. Studio → Compose → channel: Instagram → publish a single-image post.
4. Open Instagram → show the published post on the Business account.
5. (Optional) From a second IG account, comment on the post.
6. SquadPitch → Settings → Channels → click **Sync comments now** on the Instagram card. Expect "Queued ✓".
7. Open SquadInbox → the new comment appears as an INSTAGRAM conversation.
8. Reply → send. Show on instagram.com that the reply is live under the post.

### Segment C — Threads (already proven live — kept short)
1. Settings → Channels → show connected Threads card.
2. Studio → Compose → channel: Threads → publish.
3. Open Threads → show post.
4. From a second account, reply to the post.
5. SquadPitch → Channels → click **Sync replies now** on the Threads card.
6. Open SquadInbox → the reply appears as a THREADS conversation. Reply → send. Show live on Threads.

**Things to explicitly NOT say or show in the video:**
- "Direct messages" / "DMs" / "Messenger" / "private messages"
- Any of the forbidden scopes (full list in `META_APP_REVIEW_SCOPE_AUDIT_POLLING_FINAL.md` § 3)
- The Meta Dashboard webhook configuration (we don't use it for inbox anymore)

---

## 7. Pre-flight checklist (10 minutes before recording)

- [ ] `fly secrets list -a squadpitch-api` shows all 11 required active secrets above.
- [ ] (Optional) `META_COMMENT_POLLING_ENABLED=true` if you want to demo background polling, otherwise the manual Sync buttons suffice.
- [ ] `fly status -a squadpitch-api` shows all machines healthy.
- [ ] Test workspace has fresh FB + IG + Threads connections (or reconnect to refresh tokens).
- [ ] Tested Sync-comments flow at least once before recording so timing is predictable.
- [ ] Second account ready for cross-account commenting (this is the only path that actually creates inbox-visible comments — self-commenting is silently filtered by Meta).
- [ ] All four pollers' boot logs visible if you want to show them: FB / IG / Threads / metrics sync.
