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

Spinstr01 expanded to the full ladder. Five modes selectable; one
(`auto_publish_guarded`) intentionally locked.

| Mode | UI label | Behavior |
|---|---|---|
| `off` | Off | Disabled. No recs, no drafts, no scheduling. |
| `recommend_only` | Recommendations only | Evaluator emits recs; Generate stays a manual click. |
| `draft_on_click` | Generate drafts manually | MVP baseline. Evaluator emits recs; user clicks Generate. |
| `auto_generate_drafts` | Auto-prepare drafts for review | After detector emits recs, auto-generate drafts for *high-confidence* ones (has `sourceDataItemId`, non-generic title, not `INACTIVITY_GAP`). Idempotent — already-generated recs are skipped. |
| `schedule_after_approval` | Auto-schedule approved drafts | On Approve, server picks safe default slots (next 3 weekdays, 10am UTC, quiet-hour aware) and calls `draftWorkflow.scheduleDraft` for each. |
| `auto_publish_guarded` | Auto-publish (coming soon) | **NOT SELECTABLE.** UI shows a locked Coming Soon card. Schema rejects on save. |

Legacy `draft_only` is still accepted on the wire and normalized to
`draft_on_click` on read. Same for `schedule_approved`, `auto_publish`,
`draft_assist`, and `auto_publish_guarded` (defensive — schema rejects
the latter but a hand-edited row still normalizes to draft_on_click).
Nothing publishes without explicit user approval.

### 2a. Recommendation Quality (Spinstr423 + Spinstr02)

Two layers of dedup keep the Inbox clean:

1. **Intake dedup.** `saveImportedItems()` in
   `dataImport.service.js` now matches the dedicated
   `listingIngestion.service.js` path: PROPERTY items with the
   same `externalListingId` / `mlsId` / `listingUrl` /
   normalized street address collapse onto the existing row
   instead of creating a second WorkspaceDataItem. The merge
   is "prefer richer" — non-null fields from the new payload
   fill gaps in the existing `dataJson` but don't clobber
   non-null existing values, so a sparse re-import never
   strips photos off an enriched row. Non-PROPERTY items
   bulk-insert unchanged (testimonials, FAQs, etc. may
   legitimately repeat).

2. **Autopilot detector dedup.** Even when two PROPERTY rows
   sneak through (legacy data, two providers), the NEW_LISTING
   and OPEN_HOUSE detectors collapse by `listingDedupKey()` —
   MLS id > normalized street address > normalized title — and
   pick the richest record via `listingRichnessScore()`
   (images worth +10, price/beds/baths/sqft +1 each, long
   description +1). At most `REC_MAX_NEW_LISTINGS_PER_RUN = 3`
   new listing recs per evaluator tick; existing recs stay
   visible across runs.

Recommendation payload always carries: `propertyTitle`,
`propertyAddress`, `propertyCity/State/Zip`, `propertyPrice`,
`propertyBeds/Baths/Sqft`, `propertyImageUrl`,
`sourceDataItemId`, `dedupKey`, `confidence`. The UI uses
these to render `"New Listing: 508 King George Court"` instead
of the old generic `"your new listing"` headline.

Per-trigger copy (`whatWeNoticed` / `whyItMatters`) is
type-specific — NEW_LISTING speaks to launch / buyer interest
/ showing CTA, OPEN_HOUSE to event reminder / urgency,
NEW_REVIEW to trust / social proof, INACTIVITY_GAP to
consistency / re-engagement. Generic placeholder copy is
gone.

### 2b. Command Center UI (Spinstr03)

The Autopilot page (`/workspaces/:id/autopilot`) used to render
the inbox as a stack of large planner-style cards. After
Spinstr03 the page is laid out as an AI marketing command
center. Same data, same handlers, same backend — different
composition.

**Layout (Inbox tab, top to bottom):**

1. **Header** — title `Autopilot`, subtitle `AI campaign
   opportunities prepared for your review`, status pill
   (`Active` / `Off` / `Setup Required`).
2. **Summary tiles** — five metric chips:
   `Opportunities` (`pendingCount`), `Drafts Ready`
   (`readyCount`), `Approved`, `Scheduled`, `Last Scan`
   (relative time from `status.lastActionAt`). Rendered as
   `CommandSummaryTiles`.
3. **Safety callout** — persistent: *"Autopilot watches your
   business for timely marketing opportunities, prepares
   campaign drafts, and waits for your approval before
   anything reaches your planner."*
4. **Next best move** — `OpportunityHero`. The single
   highest-priority recommendation rendered as a large
   featured card with property image, full
   `whatWeNoticed` + `whyItMatters` copy, channel chips,
   confidence pill, and a single strong CTA. The CTA label
   matches the lifecycle stage (`Prepare Drafts` for pending,
   `Approve Drafts` for ready, `View Drafts` for approved/
   launched). Secondary actions: View details, Dismiss.
   Selection logic lives in `commandCenter.helpers.ts`:
   status weight (pending > ready > approved) + confidence
   weight (high > medium > low) + recency bonus.
5. **Opportunity Inbox** — `OpportunityQueue`. Remaining
   recommendations as compact one-line rows (icon + trigger
   label + confidence dot + status badge + title + address +
   single primary action). Filter tabs above: Recommended /
   Drafts Ready / Approved / Scheduled / Dismissed / All
   (UI-only mapping over the existing `AutopilotCampaignStatus`
   enum — backend unchanged).
6. **Recent Autopilot Activity** — `RunActivityPanel`.
   Merged feed of `AutopilotRun` rows and recent autopilot
   `Draft` rows, sorted by recency. Run rows surface the
   human-readable `reason` ("Autopilot scanned and found 3
   new opportunities"; "Skipped — preconditions not met").

**Empty / setup states (`FirstRunEmptyState`):**

- No recommendations + no channels → "Connect a channel to
  get started" with a CTA to `/settings/channels`.
- No recommendations + has channels + no data → "Add listings
  or connect a data source" with a CTA to `/data`.
- No recommendations + everything wired → polished "No
  opportunities found yet. Autopilot will surface
  recommendations as soon as it detects new listings,
  reviews, open houses, or posting gaps."

**Error state (`ErrorState`):** dedicated retry card backed
by `useAutopilotCampaignRecommendations().refetch()`. No
white screen on transient API failures.

**Feature flag preserved.** When
`NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED` is off the
old "Coming soon" shell renders unchanged.

**Files:**

- `src/components/studio/autopilot/AutopilotCommandCenter.tsx`
  — orchestrator (replaces `AutopilotCampaignsSection`).
- `CommandSummaryTiles.tsx`, `OpportunityHero.tsx`,
  `OpportunityQueue.tsx`, `RunActivityPanel.tsx`,
  `commandCenter.helpers.ts` — primitives.
- `autopilot/page.tsx` — Inbox tab now renders
  `<AutopilotCommandCenter />`; max-width bumped from
  `max-w-4xl` to `max-w-6xl` to fit the tile row.

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
