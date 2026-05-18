# Autopilot MVP — Final Implementation

**Status:** All six phases of `docs/AUTOPILOT_PRODUCT_AUDIT.md` shipped.
**Industry:** Real estate only. Non-real-estate workspaces silently no-op
at the evaluator preamble.
**Promise:** Autopilot is an *opportunity-driven marketing assistant*. It
detects real business opportunities, creates campaign recommendations,
generates drafts on user request, and supports explicit approval +
scheduling. **It does not auto-publish in the MVP.**

---

## 1. End-to-End Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│  Evaluator tick (manual / scheduled / external cron)                │
│      ↓                                                              │
│  detectAndPersistRecommendations()                                  │
│      ├─ NEW_LISTING       (per recent listing)                      │
│      ├─ OPEN_HOUSE        (per upcoming open-house event)           │
│      ├─ NEW_REVIEW        (per 4+ star review)                      │
│      └─ INACTIVITY_GAP    (workspace-scoped fallback)               │
│      ↓                                                              │
│  upsertRecommendation()  (idempotent on triggerType × objectId)     │
│      ↓                                                              │
│  AutopilotCampaignRecommendation row → NEEDS_REVIEW                 │
│      ↓                                                              │
│  Campaign Inbox UI (when NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED)│
│      ↓                                                              │
│  [DISMISS]                              [GENERATE]                  │
│      ↓                                      ↓                       │
│   DISMISSED                       generateDraftsForRecommendation() │
│   (sticky — detector              fans out across enabled channels  │
│    won't reopen)                  via aiGenerationService           │
│                                          ↓                          │
│                          AutopilotCampaignRecommendation.status     │
│                          = DRAFT_GENERATED                          │
│                          generatedDraftIds = [draft-1, draft-2, …]  │
│                                          ↓                          │
│                                      [APPROVE]                      │
│                                          ↓                          │
│                          approveRecommendation()                    │
│                          → draftWorkflow.approveDraft per child     │
│                          → (optional) draftWorkflow.scheduleDraft   │
│                                          ↓                          │
│                              APPROVED   or   SCHEDULED              │
│                                          ↓                          │
│                           Existing scheduled-publish worker         │
│                           takes SCHEDULED → PUBLISHED.              │
│                           No autopilot-specific publish path.       │
└─────────────────────────────────────────────────────────────────────┘
```

Every evaluator pass also writes an `AutopilotRun` row — including no-action,
skipped, and error ticks — so the activity feed can answer "why did
Autopilot do nothing on this tick?".

---

## 2. Supported Modes

Only two production-ready modes are exposed. The settings UI lists
exactly these:

| Mode | What it does |
|---|---|
| `off` | Autopilot is disabled. Nothing fires. |
| `draft_only` | Evaluator runs; recommendations are persisted to the Campaign Inbox. User clicks Generate to create drafts; user clicks Approve to transition them. |

`schedule_approved` and `auto_publish` modes were removed by the audit
(neither was ever wired through the evaluator + publisher). The API
schema rejects them on save (`AutopilotSettingsSchema` enum:
`["off", "draft_only"]`); legacy stored values normalize to `draft_only`
on read so existing workspaces stay in a safe state.

---

## 3. Endpoints

All workspace-scoped routes run `requireClientOwner`. The internal
evaluate-all loop runs `requireInternalAccess` (admin / developer role).

| Method | Path | Auth |
|---|---|---|
| GET | `/api/v1/workspaces/:id/autopilot/settings` | client owner |
| PUT | `/api/v1/workspaces/:id/autopilot/settings` | client owner |
| GET | `/api/v1/workspaces/:id/autopilot/status` | client owner |
| GET | `/api/v1/workspaces/:id/autopilot/readiness` | client owner |
| GET | `/api/v1/workspaces/:id/autopilot/activity` | client owner |
| POST | `/api/v1/workspaces/:id/autopilot/run` | client owner |
| POST | `/api/v1/workspaces/:id/autopilot/scheduled-run` | client owner |
| POST | `/api/v1/workspaces/:id/autopilot/preview` | client owner |
| POST | `/api/v1/workspaces/:id/autopilot/execute` | client owner |
| GET | `/api/v1/workspaces/:id/autopilot/campaign-recommendations` | client owner |
| GET | `/api/v1/workspaces/:id/autopilot/campaign-stats` | client owner |
| POST | `/api/v1/workspaces/:id/autopilot/campaign-recommendations/:recId/dismiss` | client owner |
| POST | `/api/v1/workspaces/:id/autopilot/campaign-recommendations/:recId/generate` | client owner |
| POST | `/api/v1/workspaces/:id/autopilot/campaign-recommendations/:recId/approve` | client owner |
| GET | `/api/v1/workspaces/:id/autopilot/runs` | client owner |
| POST | `/api/v1/internal/autopilot/evaluate-all` | internal access |

**Not implemented (deferred):** `POST .../convert`. The Inbox UI still
exposes an "Edit in Builder" button, but it `router.push`es to the
existing `/create` flow with query params — no server call.

---

## 4. Data Models

### `AutopilotCampaignRecommendation`

```
id                   PK
clientId             FK → Client (cascade)
createdAt
updatedAt
expiresAt            (sweeper flips NEEDS_REVIEW / DRAFT_GENERATED → EXPIRED past this)
triggerType          enum AutopilotTriggerType
triggerObjectType    String?  (e.g. "listing", "review")
triggerObjectId      String?  (nullable for triggers without an object)
status               enum AutopilotRecommendationStatus
headline             Text
whatWeNoticed        Text
whyItMatters         Text
recommendedChannels  String[]
recommendedAngles    Json
generatedDraftIds    String[] (populated by Phase 3 Generate)
dismissedReason      String?
decidedBy            String?  (Auth0 sub of the actor)
payloadJson          Json?    (per-trigger whitelist)

UNIQUE (clientId, triggerType, triggerObjectId)   -- idempotency
INDEX (clientId, status, createdAt)
INDEX (expiresAt)
```

**Enums:**
- `AutopilotTriggerType`: `NEW_LISTING | PRICE_DROP | OPEN_HOUSE | JUST_SOLD | STALE_LISTING | NEW_REVIEW | MARKET_UPDATE | SEASONAL | INACTIVITY_GAP`
- `AutopilotRecommendationStatus`: `NEEDS_REVIEW | DRAFT_GENERATED | APPROVED | SCHEDULED | DISMISSED | EXPIRED`

### `AutopilotRun`

```
id                       PK
clientId                 FK → Client (cascade)
triggerSource            enum: MANUAL | SCHEDULED | EVENT
status                   enum: CREATED_RECOMMENDATIONS |
                               UPDATED_RECOMMENDATIONS |
                               NO_ACTION | SKIPPED | ERROR
reason                   Text?
recommendationsCreated   Int
recommendationsUpdated   Int
recommendationsExpired   Int
settingsSnapshot         Json?
readinessSnapshot        Json?
startedAt                DateTime
finishedAt               DateTime?
errorMessage             Text?
metadata                 Json?

INDEX (clientId, startedAt)
INDEX (startedAt)
```

---

## 5. Scheduler Behavior

- **Mechanism**: BullMQ worker (`workers/autopilotEvaluatorWorker.js`).
- **Default**: OFF (`AUTOPILOT_SCHEDULER_ENABLED=false`).
- **Interval**: configurable via `AUTOPILOT_SCHEDULER_INTERVAL_MIN`
  (default 360 = 6 hours; min 5).
- **Per-tick action**: Calls `evaluateAllAutopilotWorkspaces`, which
  iterates every CONNECTED workspace with `autopilot.enabled = true`
  and `autopilot.mode ≠ "off"`, then calls
  `runScheduledAutopilot(workspaceId)` for each.
- **Per-workspace evaluation**: Wrapped in `recordRun` so every tick
  produces an `AutopilotRun` row, including no-action / skipped / error
  outcomes.
- **External cron is still supported** via
  `POST /api/v1/internal/autopilot/evaluate-all` (admin/developer only).

---

## 6. Run History Behavior

`GET /api/v1/workspaces/:id/autopilot/runs` returns the workspace's runs
newest-first, paginated. Each row carries:
- `triggerSource`: `manual | scheduled | event`
- `status`: `created_recommendations | updated_recommendations | no_action | skipped | error`
- `reason`: human-readable explanation
- `recommendationsCreated / Updated / Expired`
- `startedAt / finishedAt`
- `errorMessage`

Frontend hook: `useAutopilotRuns(clientId)` in `src/hooks/useSquadpitch.ts`.

---

## 7. Idempotency Guarantees

| Action | Mechanism |
|---|---|
| Repeated evaluator runs | `(clientId, triggerType, triggerObjectId)` composite unique + `upsertRecommendation` two-step find→update OR create with P2002 race fallback. |
| Scheduler ticks | Same path as manual evaluator runs — no new duplication surface. |
| Repeat Generate clicks | If `generatedDraftIds` is non-empty, return existing drafts. No re-fan-out. |
| Repeat Approve clicks | Drafts already past APPROVED are skipped (not errored). Same-time SCHEDULED is a no-op. |
| Repeat Dismiss clicks | Already-DISMISSED returns the existing row unchanged. |
| User-decided rows | DISMISSED / APPROVED / SCHEDULED / DRAFT_GENERATED rows stay sticky. Detector re-runs touch `updatedAt` + `expiresAt` only — never re-open the row or wipe the user's reason. |

---

## 8. Channel Safety

- `generateDraftsForRecommendation` intersects `recommendation.recommendedChannels`
  with `ChannelSettings.isEnabled`.
- Per-plan `requiresImage` list drops channels (currently only INSTAGRAM)
  when `payloadJson.propertyImageUrl` is missing.
- Skipped channels appear in the response (`{ channel, reason }`) so the
  UI can explain why a channel was dropped.
- Drafts returned with `status=FAILED` by the provider DO NOT count as
  success. All-channels-failed → recommendation stays NEEDS_REVIEW.
- No SMS path. No Google Business Profile local-post assumption.

---

## 9. Feature Flags / Env Vars

| Var | Default | Purpose |
|---|---|---|
| `AUTOPILOT_SCHEDULER_ENABLED` | `false` | Starts the BullMQ evaluator worker. |
| `AUTOPILOT_SCHEDULER_INTERVAL_MIN` | `360` | Worker tick interval in minutes (min 5). |
| `NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED` *(web)* | `false` | When false, the Campaign Inbox renders a coming-soon empty state and the read/dismiss/generate/approve hooks never fire. Flip to true to surface the inbox to users. |

To roll Autopilot out in prod:

```bash
fly secrets set -a squadpitch-api \
  AUTOPILOT_SCHEDULER_ENABLED=true \
  AUTOPILOT_SCHEDULER_INTERVAL_MIN=360

# After the API is live + the migration ran, expose to users:
fly secrets set -a squadpitch-web \
  NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED=true
```

---

## 10. Tests + Build Status

**API**: 867/867 passing, including:
- `tests/autopilotPhase1.test.js` (10) — mode enum + legacy normalization
- `tests/autopilotPhase2.test.js` (14) — upsert idempotency, sticky decisions, list/stats, dismiss, FE shape
- `tests/autopilotPhase3.test.js` (9) — generate fan-out, idempotency, Instagram-no-media skip, partial / all-failure
- `tests/autopilotPhase4.test.js` (10) — approve happy path, schedule, already-past idempotency, refusals, no-publish
- `tests/autopilotPhase5.test.js` (9) — startRun/finishRun/recordRun, listRuns tenant-scope + empty
- `tests/autopilotPhase6Integration.test.js` (2) — full E2E Inbox → Generate → Approve, with + without `scheduleAt`

**Web**: 272/272 passing; typecheck clean.

---

## 11. Known Limitations

- **5 trigger types still planned**: PRICE_DROP, STALE_LISTING, JUST_SOLD,
  MARKET_UPDATE, SEASONAL. Detectors documented in
  `docs/AUTOPILOT_PRODUCT_AUDIT.md §5`. Wired triggers today: NEW_LISTING,
  OPEN_HOUSE, NEW_REVIEW, INACTIVITY_GAP.
- **Convert endpoint deferred**. "Edit in Builder" button navigates to
  `/create` with pre-filled query params — no server-side materialization.
- **Scheduler runs all workspaces in series**. With ~50 workspaces and
  a 6h interval the throughput is fine; once we cross ~500 we'll want to
  fan out per-workspace jobs.
- **AI prompt egress** to OpenAI not surfaced to users in-product (still
  in privacy policy scope).

---

## 12. What Remains Deferred

| Item | Why | Status |
|---|---|---|
| `auto_publish` mode | Audit pulled it; no autonomous publish in MVP. | **Not building** |
| `schedule_approved` mode | Same — would need cross-team approval first. | **Not building** |
| Autonomous ads | SquadAds is its own surface. | Out of scope |
| SMS blast automation | A2P gating + UX risk. | Out of scope |
| Non-real-estate Autopilot | Each industry needs its own trigger taxonomy. | Out of scope |
| Convert endpoint | Manual nav covers the use case; no clear server-side intent. | Deferred (low priority) |
| Per-workspace BullMQ jobs | Premature optimization. | Defer until > 500 workspaces |
| Random / daily content generation | Anti-product. | **Not building** |

---

## 13. Confirmation

**No auto-publish path exists in the Autopilot MVP.**

- `runAutopilot` / `runScheduledAutopilot` only emit
  `AutopilotCampaignRecommendation` rows. They never create Drafts.
- `generateDraftsForRecommendation` creates Drafts at `status=DRAFT`
  only — never `APPROVED`, `SCHEDULED`, or `PUBLISHED`.
- `approveRecommendation` transitions child Drafts to APPROVED, and
  (only when `scheduleAt` is provided) to SCHEDULED. It never calls
  `publishDraft` and never touches any publishing adapter.
- The scheduler worker only calls the evaluator. It does not call
  Generate, Approve, or Publish.
- `publishingService.js` already has no auto-publish path in any mode
  (verified during the audit).
