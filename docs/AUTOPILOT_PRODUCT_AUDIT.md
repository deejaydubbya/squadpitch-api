# Autopilot Product Audit

**Status:** All six phases shipped. See `docs/AUTOPILOT_MVP_IMPLEMENTATION.md`
for the final-state reference.
**Repos audited:** squadpitch-api, squadpitch-web.
**Baseline at audit:** API 813 passing, web typecheck clean.
**After Phase 1:** API 823 passing, web 272 passing, web typecheck clean.
**After Phase 2:** API 837 passing, web 272 passing, web typecheck clean.
**After Phase 3:** API 846 passing, web 272 passing, web typecheck clean.
**After Phase 4:** API 856 passing, web 272 passing, web typecheck clean.
**After Phase 5:** API 865 passing, web 272 passing, web typecheck clean.
**After Phase 6:** API 867 passing, web 272 passing, web typecheck clean.

---

## 1. Autopilot Product Definition (canonical)

Squadpitch Autopilot is an **opportunity-driven marketing assistant** for the
real-estate workspace.

It monitors a workspace's business data, detects timely marketing opportunities,
recommends campaigns, and generates channel-specific drafts for review.
**Autopilot does not publish content without user approval in the initial
production version.** Primary purpose: help businesses consistently market
important events, listings, offers, reviews, and seasonal opportunities without
needing to manually decide what to create next.

Autopilot is **not**:

- A random daily AI post generator
- A generic scheduler
- An auto-publisher
- A "set it and forget it" system yet
- A replacement for user approval in the MVP

**MVP surface:** *Autopilot Campaign Inbox* — the workspace owner sees
recommendation rows like "Open House this Saturday — generate a 3-post
campaign?" with a clear explanation, the underlying business object, the
recommended channels, and an action set (preview, generate, edit,
approve/schedule, dismiss).

**Industry scope:** Real estate only. Car sales planned, not implemented.

---

## 2. Current Systems Map

| System / File | What it does | FE uses it? | BE route | MVP fit? | Recommendation |
|---|---|---|---|---|---|
| `autopilot.service.js` | Scheduled rule-based evaluator. Picks 0–2 angles per run, creates Drafts tagged `createdBy: "system:autopilot"`. Real-estate gated. | Indirectly via `useAutopilotStatus`, `useAutopilotActivity`, `useAutopilotReadiness`, `useAutopilotSettings` | `POST /autopilot/run`, `/scheduled-run`, `/internal/.../evaluate-all`, `GET status\|readiness\|activity`, `GET/PUT settings` | Partial — produces drafts, not campaigns. | **Keep + refactor in Phase 2.** Rewire output target from "create Draft" to "create CampaignRecommendation". |
| `dataAwareAutopilot.service.js` | User-triggered preview + batch-execute. | `AutopilotPanel.tsx` | `POST /autopilot/preview`, `/execute` | Misaligned — conflates suggest + draft in one click. | **Merge in Phase 3.** Preview side useful; execute should write drafts only after a CampaignRecommendation is approved. |
| `recommendationEngine.service.js` | Shared scoring/ranking engine used by Dashboard, Create Content, Listing Campaign. ~1950 lines. | Multiple non-autopilot surfaces | Various | Reusable building block. | **Keep.** Extract the "what to recommend" half as the input to the new CampaignRecommendation persister. |
| `plannerSuggestion.service.js` | Calendar planner ghost suggestions. | Calendar/planner UI | `getPlannerSuggestions`, `planMyWeek`, `swapSuggestion` | Out of scope. | **Keep separate.** |
| `aiGenerationService.js` | Model-agnostic OpenAI facade. | All draft generation | Indirect | Primitive. | **Keep.** |
| `draftWorkflow.service.js` | Draft state machine: DRAFT → APPROVED → SCHEDULED/PUBLISHED. | Draft approval surfaces | `POST /drafts/:id/transition` | Yes. | **Keep.** Use as the back half of the campaign approval flow. |
| `publishingService.js` | Routes to channel adapter. No auto-publish path anywhere. | User-initiated publish | `POST /drafts/:id/publish` | Yes — only user-initiated. | **Keep + don't extend with auto-publish.** |
| `workers/` autopilot | **None.** External cron hits `/internal/.../evaluate-all`. | n/a | n/a | Acceptable for MVP. | Add BullMQ worker in Phase 5. |
| Prisma models | `WorkspaceTechStackConnection` with `providerKey="_autopilot_settings"` only. **No model persists recommendation lifecycle.** | n/a | n/a | Misaligned. | **Add `AutopilotCampaignRecommendation` + `AutopilotRun` in Phase 2.** |

---

## 3. Frontend ↔ API Contract

The web side already calls a fully-formed Campaign Inbox API. Most of it
**did not exist on the backend** — every `useAutopilotCampaign*` hook 404'd
until Phase 1 gated them behind a feature flag.

| Frontend caller | Endpoint | BE? | Phase 1 status | Recommended fix |
|---|---|---|---|---|
| `useAutopilotPreview` | `POST /autopilot/preview` | ✅ | Still wired | Keep; pivot output shape in Phase 2. |
| `useAutopilotExecute` | `POST /autopilot/execute` | ✅ | Still wired | Phase 3 — replace with `/campaign-recommendations/:id/generate`. |
| `useAutopilotSettings` GET/PUT | `/autopilot/settings` | ✅ | Mode enum trimmed to `off \| draft_only`. | Keep. |
| `useAutopilotReadiness` | `GET /autopilot/readiness` | ✅ | `availableModes` trimmed accordingly. | Keep. |
| `useAutopilotActivity` | `GET /autopilot/activity` | ✅ | Still wired | Keep; augment in Phase 5. |
| `useAutopilotStatus` | `GET /autopilot/status` | ✅ | Still wired | Keep. |
| `useAutopilotCampaignRecommendations` | `GET /autopilot/campaign-recommendations` | ❌ | **Gated by `NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED`; never fires today.** | Phase 2 — build endpoint + flip flag. |
| `useAutopilotCampaignStats` | `GET /autopilot/campaign-stats` | ❌ | **Same gate.** | Phase 2. |
| `useGenerateAutopilotCampaign` | `POST /autopilot/campaign-recommendations/:id/generate` | ❌ | Section never renders; mutation never fires. | Phase 3. |
| `useApproveAutopilotCampaign` | `POST /autopilot/campaign-recommendations/:id/approve` | ❌ | Same. | Phase 4. |
| `useDismissAutopilotCampaign` | `POST /autopilot/campaign-recommendations/:id/dismiss` | ❌ | Same. | Phase 2. |
| `useConvertAutopilotCampaign` | `POST /autopilot/campaign-recommendations/:id/convert` | ❌ | Same. | Defer to Phase 4. |

---

## 4. Campaign Recommendation Lifecycle

```
detected         — evaluator found a trigger (price drop, new listing, etc.)
needs_review     — surfaced to the workspace user
draft_generated  — user clicked "Generate drafts"; channel-specific drafts created
approved         — user reviewed + approved (drafts → APPROVED)
scheduled        — approved drafts queued via existing draftWorkflow
dismissed        — user dismissed
expired          — opportunity passed; auto-set by next evaluator run
```

**Storage requirement (Phase 2):** `AutopilotCampaignRecommendation` row per
opportunity:

- `id`, `clientId`, `createdAt`, `expiresAt`
- `triggerType` enum (NEW_LISTING / PRICE_DROP / OPEN_HOUSE / JUST_SOLD /
  STALE_LISTING / NEW_REVIEW / MARKET_UPDATE / SEASONAL / INACTIVITY_GAP)
- `triggerObjectType` + `triggerObjectId` — what business object kicked it off
- `status` enum (NEEDS_REVIEW / DRAFT_GENERATED / APPROVED / SCHEDULED /
  DISMISSED / EXPIRED)
- `headline`, `whatWeNoticed`, `whyItMatters`
- `recommendedChannels` String[]
- `recommendedAngles` Json
- `generatedDraftIds` String[]
- `dismissedReason` String?
- `decidedBy` String?
- Unique `(clientId, triggerType, triggerObjectId)` to **prevent duplicates**.

---

## 5. Real Estate Opportunity Types

| Trigger | Detects | Object | Default channels |
|---|---|---|---|
| NEW_LISTING | New listing added in last N days. | Listing | IG, FB, LinkedIn |
| PRICE_DROP | Listing price decreased. | Listing | IG, FB |
| OPEN_HOUSE | Listing open_house in next 7 days. | Listing.events | IG, FB, Threads |
| JUST_SOLD | Listing status flipped to "sold." | Listing | IG, FB, LinkedIn |
| STALE_LISTING | Listing active >30 days without refresh. | Listing | IG, FB |
| NEW_REVIEW | New GBP 4+ star review. | Review | IG, FB, LinkedIn |
| MARKET_UPDATE | Fresh monthly/weekly market data. | Market data | LinkedIn, FB |
| SEASONAL | Calendar event (spring buyers, fall family moves). | Calendar | IG, FB |
| INACTIVITY_GAP | Workspace hasn't published in N days. | n/a | All connected |

---

## 6. What Not To Build Yet

- **No auto-publish.** Pulled from mode enum in Phase 1.
- **No fully autonomous ads.** SquadAds is separate.
- **No SMS blast automation.** SMS gated on A2P 10DLC anyway.
- **No non–real-estate industries.** Backend gated on `industryKey === "real_estate"`.
- **No random daily content.** Every recommendation points at a concrete
  business object; INACTIVITY_GAP is the only event-free trigger.

---

## 7. Phased Build Plan

### Phase 1 — Truthful UI/API alignment ✅ SHIPPED (see §9)
### Phase 2 — Persist campaign recommendations
- Add `AutopilotCampaignRecommendation` + `AutopilotRun` Prisma models.
- Wire `GET /autopilot/campaign-recommendations`, `GET /autopilot/campaign-stats`,
  `POST .../dismiss`.
- Modify evaluator to emit recommendation rows instead of drafts.
- Flip `NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED=true` after rollout.

### Phase 3 — Generate drafts from a recommendation
- `POST /campaign-recommendations/:id/generate` fans out across channels.
- Idempotent: returns existing drafts when called twice.
- Channel filter intersects with publishable channels.

### Phase 4 — Approval + scheduling workflow
- `POST /campaign-recommendations/:id/approve` — transitions rec + drafts via
  existing `draftWorkflow`. Optional `scheduleAt` per draft.
- Optional `convert` endpoint materializes the rec as a real `Campaign` row.

### Phase 5 — Scheduler, run history, idempotency
- BullMQ worker `autopilotEvaluatorWorker.js`, repeating every 6h.
- `AutopilotRun` tracks per-evaluation: `evaluatedAt`, counts, errors.
- Activity feed augmented with run-level entries.

### Phase 6 — Auto-publish behind kill switch (deferred)
- Reintroduce `schedule_approved` / `auto_publish` modes guarded by
  workspace-level opt-in + global env kill switch.

---

## 8. Recommended Next Implementation Prompt

Phase 2: persistent `AutopilotCampaignRecommendation` model + the three
read/dismiss endpoints that the UI already speaks.

---

## 9. Phase 1 Completion Note

**Shipped (no new backend routes/models/evaluator changes):**

- `AutopilotSettings.mode` enum trimmed to `["off", "draft_only"]` on API
  schema (rejects `auto_publish` / `schedule_approved` on save).
- `getAutopilotSettings` normalizes legacy stored modes
  (`auto_publish` / `schedule_approved` / `draft_assist`) → `draft_only` on
  read so existing workspaces don't render an unsupported mode.
- `getAutopilotReadiness.availableModes` no longer surfaces `schedule_approved`.
- Web `AutopilotMode` union shrunk to match.
- Mode label maps in `autopilot/page.tsx`, `settings/autopilot/page.tsx`,
  `AutopilotStatusCard.tsx` reduced to the two supported modes. Copy
  swapped from "Draft Only" → "Prepare drafts for review."
- New feature flag `NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED`
  (default false) at `src/lib/autopilotCampaignInbox.ts`.
- `useAutopilotCampaignRecommendations` + `useAutopilotCampaignStats` are
  hook-level gated on the flag — the 404-prone queries never fire today.
- `AutopilotCampaignsSection` renders a coming-soon empty state when the
  flag is off; component tree preserved so Phase 2 wiring needs no UI
  rewrite. `AutopilotInboxBanner` returns null behind the same flag.

**No backend routes, no Prisma models, no evaluator changes.**

**Tests:** 10 new API tests (mode-enum + legacy normalization), 3 new web
tests (flag default + true/false discrimination). Suites:
**API 823/823 passing; Web 272/272 passing; web typecheck clean.**

**Next step:** Phase 2 — persistent `AutopilotCampaignRecommendation` model
+ read/dismiss endpoints. Flip `NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED`
after rollout.

---

## 10. Phase 2 Completion Note

**Shipped:**

- New Prisma model `AutopilotCampaignRecommendation` with two enums
  (`AutopilotTriggerType`, `AutopilotRecommendationStatus`) + a
  composite unique on `(clientId, triggerType, triggerObjectId)` for
  idempotency. Migration `20260518000001_autopilot_campaign_recommendations`.
  Pure additive; no other tables touched.
- New service `domains/studio/autopilotCampaignRecommendation.service.js`:
  - `upsertRecommendation` — idempotent. **User-decided rows
    (DISMISSED / APPROVED / SCHEDULED / DRAFT_GENERATED) are sticky** —
    a re-detection touches `updatedAt` + `expiresAt` but never
    re-opens the row.
  - `listRecommendations` — paginated; default filter excludes EXPIRED.
  - `getStats` — empty workspace returns zeros (not 404).
  - `dismissRecommendation` — idempotent + tenant-scoped.
  - `expireStaleRecommendations` — sweeps NEEDS_REVIEW /
    DRAFT_GENERATED rows past `expiresAt` to EXPIRED on every tick.
  - `toFrontendShape` — maps the BE row to the existing FE
    `AutopilotCampaignRecommendation` interface so Phase 2 doesn't
    require a UI rewrite.
- New routes (all requireClientOwner, no FE shape change):
  - `GET /api/v1/workspaces/:id/autopilot/campaign-recommendations` —
    supports `?status=pending,ready,...` + `?limit` + `?offset`.
  - `GET /api/v1/workspaces/:id/autopilot/campaign-stats`.
  - `POST /api/v1/workspaces/:id/autopilot/campaign-recommendations/:id/dismiss` —
    audit-logged via `inbox`-style writeAudit (action
    `autopilot.recommendation.dismissed`).
- Evaluator rewired. `runAutopilot` + `runScheduledAutopilot` no
  longer create Drafts. They now run `detectAndPersistRecommendations`
  + `expireStaleRecommendations`. Detector covers four triggers in
  this phase:
  - NEW_LISTING (per listing, last 14 days)
  - OPEN_HOUSE (per listing with a future open_house event)
  - NEW_REVIEW (per recent 4+ star review)
  - INACTIVITY_GAP (workspace-scoped, fallback)
  Planned but not yet wired (need data we don't track today):
  PRICE_DROP, STALE_LISTING, JUST_SOLD, MARKET_UPDATE, SEASONAL.
- Response shape of `/autopilot/run` updated:
  - `drafts: []`, `draftsCreated: 0` (preserved for old callers)
  - `recommendationsCreated`, `recommendationsUpdated`,
    `recommendationsExpired` (new)
  - `action`: `"recommended"` when at least one rec was emitted,
    else `"no_action"`.
- Frontend `AutopilotCampaignsSection` Live branch wired:
  - Reads from the three new endpoints when
    `NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED=true`.
  - **Dismiss** mutation fires for real (route exists).
  - **Generate / Approve** click handlers route to a `notifyComingSoon`
    alert — the routes ship in Phase 3 / Phase 4.
  - **Convert** still navigates to the existing create-campaign
    flow (manual materialization until Phase 4 server-side).
  - Empty state preserved when the flag is off.

**No changes to publishing, draft generation from approved Drafts,
auto-publish, or the existing /preview /execute paths.**

**Tests:** 14 new (idempotency, sticky user decisions,
tenant-scoping, dismiss flow, list/stats defaults, FE shape mapping).
Suites: **API 837/837 passing; Web 272/272 passing; web typecheck clean.**

**To roll out:**
1. Deploy API + run migration.
2. Deploy web (no env flag change required to ship the code).
3. When ready to surface the Campaign Inbox to users, set
   `NEXT_PUBLIC_AUTOPILOT_CAMPAIGN_INBOX_ENABLED=true` on the
   web Fly secrets and redeploy the web app.

**Next step:** Phase 3 — generate drafts from a recommendation.
Wires `POST /autopilot/campaign-recommendations/:id/generate` (fan
out across `recommendedChannels`, store draft ids on the rec,
transition status to DRAFT_GENERATED). Replaces the Phase 2
"coming soon" alert on the Generate button.

---

## 11. Phase 3 Completion Note

**Shipped:**

- New service helper
  `generateDraftsForRecommendation({ clientId, recommendationId, userId })`
  in `domains/studio/autopilotCampaignRecommendation.service.js`:
  - Trigger → plan mapping for 7 trigger types: NEW_LISTING,
    OPEN_HOUSE, PRICE_DROP, JUST_SOLD, STALE_LISTING, NEW_REVIEW,
    INACTIVITY_GAP. Each plan carries `templateType`, `kind`,
    `guidance`, `dataItemId`, and `requiresImage` so the channel
    intersector can drop Instagram when there's no photo.
  - Channel intersection: `recommendation.recommendedChannels`
    ∩ `ChannelSettings.isEnabled`. Skipped reasons surfaced in
    the response (`{ channel, reason }`).
  - Calls the existing `aiGenerationService.generateDraft` once
    per eligible channel. Drafts returned with status=FAILED by
    the provider DO NOT count as success.
  - Idempotent: if `generatedDraftIds` is already non-empty,
    return the existing drafts unchanged (no re-fan-out).
  - Refuses DISMISSED / EXPIRED recommendations (412).
  - Refuses cross-workspace access (404).
  - All-channel-failure DOES NOT flip status — the rec stays
    NEEDS_REVIEW so the user can retry once the underlying
    issue is resolved.
  - At least one success → status flips to DRAFT_GENERATED,
    draft ids stored on `generatedDraftIds`. Returns
    `{ status, drafts: [...], skipped: [...], recommendation }`
    with `status` ∈ `success | partial_success | noop | failed`.
- New route:
  `POST /api/v1/workspaces/:id/autopilot/campaign-recommendations/:recommendationId/generate`
  — owner-gated, audit-logged
  (`autopilot.recommendation.generate.<status>`).
- Frontend `useGenerateAutopilotCampaign` return type updated to
  `AutopilotGenerateResult` (was incorrect — the server returns
  a fan-out result, not just the rec). The Inbox section's
  Generate click now fires the mutation and renders a summary
  alert with skipped-channel reasons.
- Approve / convert still ship in Phase 4 — those click handlers
  remain on the `notifyComingSoon` path.

**No auto-publish path added.** Every generated draft lands at
status=DRAFT and the user must approve / schedule / publish via
the existing flows.

**Tests:** 9 new (idempotency, ineligible-state refusal,
tenant scoping, partial success with Instagram skip, no-eligible-
channels, all-channel-failure DOES NOT flip status). Suites:
**API 846/846 passing; Web 272/272 passing; web typecheck clean.**

**Next step:** Phase 4 — approval + scheduling workflow.
`POST .../approve` transitions the recommendation and each child
draft to APPROVED via the existing `draftWorkflow.service`.
Optional `scheduleAt` per draft. Replaces the Phase 3 coming-soon
alert on the Approve button.

---

## 12. Phase 4 Completion Note

**Shipped:**

- New service helper `approveRecommendation({ clientId,
  recommendationId, userId, scheduleAt? })`:
  - Refuses when no `generatedDraftIds` (400 NO_GENERATED_DRAFTS).
  - Refuses DISMISSED / EXPIRED (412 RECOMMENDATION_NOT_ELIGIBLE).
  - Tenant-isolated (404 cross-workspace; no draft mutations).
  - Transitions each child Draft via existing
    `draftWorkflow.approveDraft`. When `scheduleAt` is provided,
    follows with `draftWorkflow.scheduleDraft` (validates the
    date — future-only).
  - Idempotent: drafts already past APPROVED are skipped;
    same-time SCHEDULED skips the re-schedule.
  - Rec status: all children APPROVED → APPROVED; all SCHEDULED
    + scheduleAt → SCHEDULED; any per-draft error → stays put
    + status=partial_success.
- New route:
  `POST /api/v1/workspaces/:id/autopilot/campaign-recommendations/:recommendationId/approve`
  — owner-gated, audit-logged
  (`autopilot.recommendation.approve.<status>`).
- Convert is **deferred** per the audit's "intent unclear" note.
  FE handler keeps the manual nav to `/create`; no server route
  added, no visible 404.
- `useApproveAutopilotCampaign` input updated to
  `{ recommendationId, scheduleAt? }`. New
  `AutopilotApproveResult` shape.
- Campaign Inbox section's Approve button wired. Success alert
  reports approved-count + any per-draft errors. No
  "auto-publish" / "automatically posts" language.

**No publish path added.** Drafts move to APPROVED / SCHEDULED
only; the existing scheduled-publish worker handles SCHEDULED →
PUBLISHED.

**Tests:** 10 new (happy-path, schedule fan-out, idempotency,
refusals, never-publishes guarantee, partial-failure). Suites:
**API 856/856 passing; Web 272/272 passing; web typecheck clean.**

**Lifecycle now fully wired**: NEEDS_REVIEW → DRAFT_GENERATED →
APPROVED → SCHEDULED → DISMISSED / EXPIRED (terminal).

**Next step:** Phase 5 — scheduler worker + run history. Wires
the BullMQ worker that calls `runScheduledAutopilot` on an
interval, persists `AutopilotRun` rows with per-tick counts, and
augments the activity feed with run-level entries.

---

## 13. Phase 5 Completion Note

**Shipped:**

- New Prisma model `AutopilotRun` + enums `AutopilotRunSource` /
  `AutopilotRunStatus`. Migration
  `20260518000002_autopilot_runs`. Indexed on
  `(clientId, startedAt)`.
- New service `domains/studio/autopilotRun.service.js`:
  - `startRun` / `finishRun` — best-effort writes (a logging
    failure NEVER fails the evaluator).
  - `recordRun(opts, fn)` — wraps the evaluator: opens a run,
    runs `fn`, finishes with the outcome. On throw, records
    `ERROR` and re-throws.
  - `listRuns({ clientId, limit, offset })` — paginated, FE-
    shaped (status/source lowercased), empty workspace returns
    `[]` (200, not 404).
- `runAutopilot` and `runScheduledAutopilot` now share a single
  evaluator body wrapped in `recordRun`. **Every tick writes an
  `AutopilotRun` row** — including no-action, skipped, and error
  ticks. The activity feed can finally explain WHY Autopilot
  did nothing.
- Internal endpoint protection:
  `POST /api/v1/internal/autopilot/evaluate-all` now requires
  `requireInternalAccess` (admin/developer). A normal user JWT
  can no longer trigger a fleet-wide evaluation.
- New endpoint `GET /api/v1/workspaces/:id/autopilot/runs`
  (owner-gated, paginated, newest-first).
- New BullMQ worker
  `workers/autopilotEvaluatorWorker.js`. Default-OFF behind
  `AUTOPILOT_SCHEDULER_ENABLED`. Interval configurable via
  `AUTOPILOT_SCHEDULER_INTERVAL_MIN` (default 360 = 6h). Calls
  `evaluateAllAutopilotWorkspaces` per tick. Registered in
  `server.js` alongside the other periodic workers.
- Frontend hook `useAutopilotRuns` + `AutopilotRun` type — UI
  surfaces can render the run history (existing Activity card
  can drop in a `useAutopilotRuns` call when ready).

**Idempotency**: re-runs against the same `(clientId, triggerType,
triggerObjectId)` opportunity continue to update rather than
duplicate (composite unique on the recommendations table). The
scheduler adds no new duplication surface — every tick goes
through the same `upsertRecommendation` path Phase 2 wired.

**No publish path added.** The scheduler creates / updates
recommendations only. Drafts still require a user click on
Generate (Phase 3). Approvals still require a user click on
Approve (Phase 4).

**New env vars:**
- `AUTOPILOT_SCHEDULER_ENABLED` (default `false`)
- `AUTOPILOT_SCHEDULER_INTERVAL_MIN` (default `360`)

To turn the scheduler on in prod:
```
fly secrets set -a squadpitch-api AUTOPILOT_SCHEDULER_ENABLED=true
```

**Tests:** 9 new (startRun + finishRun + recordRun success/error
paths, no_action / skipped / error rows persisted, listRuns
tenant-scoped + empty-workspace + clamp). Suites: **API 865/865
passing; Web 272/272 passing; web typecheck clean.**

**Next step:** Phase 6 — final hardening + end-to-end test pass.
Audit-doc-wide review, integration coverage across the full
Inbox → Generate → Approve → Schedule chain, and the
conditional re-introduction of `schedule_approved` / `auto_publish`
modes behind workspace-level opt-in + a global kill switch.

---

## 14. Spinstr01 — Mode Ladder Upgrade Completion Note

**Date:** 2026-05-16

Expanded the Autopilot mode system from the two-mode MVP
(`off` / `draft_only`) to the full automation ladder.

**Modes (all selectable except the last):**

| Mode | UI label | Behavior |
|---|---|---|
| `off` | Off | Disabled. |
| `recommend_only` | Recommendations only | Detector emits recs. No drafts. |
| `draft_on_click` | Generate drafts manually | MVP baseline. Replaces / aliases `draft_only`. |
| `auto_generate_drafts` | Auto-prepare drafts for review | After detect, auto-generate drafts for *high-confidence* recs only (concrete `sourceDataItemId`, non-generic title, trigger in NEW_LISTING / OPEN_HOUSE / PRICE_DROP / JUST_SOLD / NEW_REVIEW). Idempotent. |
| `schedule_after_approval` | Auto-schedule approved drafts | On Approve with no explicit `scheduleAt`, picks safe default slots (next N weekdays at 10am UTC, quiet-hour aware) and calls `draftWorkflow.scheduleDraft` per draft. |
| `auto_publish_guarded` | Auto-publish guarded campaigns | **NOT SELECTABLE.** Schema rejects on save. UI shows a locked Coming Soon card. |

**Backward compatibility:** `draft_only`, `draft_assist`,
`schedule_approved`, `auto_publish`, `auto_publish_guarded` all
normalize to `draft_on_click` on read. Existing workspaces with
any of these stored modes load into a safe live mode without
manual intervention. The on-the-wire enum accepts `draft_only`
explicitly so a saved settings PATCH from an older client
doesn't 400.

**Auto-generate guardrails:**

- Skipped if `sourceDataItemId` is absent.
- Skipped if `INACTIVITY_GAP` (content quality bar too low).
- Skipped if the title looks generic (no address / no
  signal — defensive against the "your new listing" class of
  bug fixed in Spinstr423).
- Skipped if the recommendation already has
  `generatedDraftIds` (idempotency — repeated detector runs
  don't pile on).
- Skipped if the existing `checkGuardrails` returns `block`
  (daily draft cap, recent send cooldown).
- Skip reasons recorded in the `AutopilotRun.metadata.steps`
  array so the Activity tab can show "1 generated, 2
  skipped — INACTIVITY_GAP, no source data item".

**Schedule-after-approval guardrails:**

- Only runs when `scheduleAt` is not explicitly passed (an
  explicit calendar pick from the UI always wins).
- `buildAutoScheduleSlots` skips Sat/Sun and any hour in the
  configured quiet window.
- Per-draft slots are passed to `draftWorkflow.scheduleDraft`
  individually so existing per-draft channel routing /
  collision detection runs unmodified.
- If scheduling fails for any draft, the rec stays in
  `APPROVED` and the failure surfaces — no silent partial
  schedule.

**Safety guarantee preserved:** no auto-publish path was
added. `auto_publish_guarded` is enum-only and intentionally
unreachable. The scheduled-publish worker continues to be the
only thing that flips `SCHEDULED → PUBLISHED`, and it only
sees rows the user explicitly approved.

**Tests:** 21 mode-enum + normalization cases
(`autopilotPhase1.test.js` expanded), 8 new mode-behavior
cases (`autopilotModesUpgrade.test.js` — auto-gen happy path,
skip rules, idempotency, `buildAutoScheduleSlots` weekday /
quiet-hour / count). Suites: **API 893/893 passing; Web
272/272 passing; web typecheck clean.**

**Migration needed?** No. Legacy stored values normalize on
read; the on-the-wire schema accepts `draft_only` as a legacy
alias, so existing settings rows continue to round-trip
without a backfill.

**Next step:** Spinstr02 — recommendation quality / dedup /
prioritization (the Spinstr423 work continues here:
listing-aware sort, per-rec specificity score, surface
"why this rec" in the Inbox card).

---

## 15. Spinstr02 — Recommendation Quality Pass Completion Note

**Date:** 2026-05-18

Spinstr423 already shipped the bulk of the Spinstr02 quality
pass: listing dedup (MLS / street / title), `listingRichnessScore`
to pick the richer record on collapse, `REC_MAX_NEW_LISTINGS_PER_RUN
= 3` cap, address-first headlines (`New Listing: <address>` /
`Open House: <address>`), per-trigger specific copy
(NEW_LISTING / OPEN_HOUSE / NEW_REVIEW / INACTIVITY_GAP each
explain what was noticed, why it matters, and what channels
Autopilot can prepare), and the UI label cleanup ("Recommended"
tab, "Drafts Ready" badge, "Generate Drafts" button).

This pass closes the residual gaps:

**1. Intake-time dedup for the generic import path.**

The dedicated `listingIngestion.service.js` path already
dedups by sourceId / listingUrl / normalized street
(`checkDuplicate`). The generic `dataImport.service.js`
`saveImportedItems()` path used by the Property Library URL /
text / Sheets / Notion importers was calling `createMany`
blindly, so the same listing imported twice via different
paths landed as two rows (e.g. "508 King George Court" — once
with photos, once without).

Fix: for PROPERTY items only, `saveImportedItems()` now
builds a dedup key (`externalListingId` / `mlsId` /
`listingUrl` / normalized street address / normalized title)
and either merges into an existing ACTIVE workspace PROPERTY
or onto an earlier row in the same batch. The merge is
"prefer richer" — non-null fields from the new payload fill
gaps in the existing `dataJson` but don't clobber non-null
existing values. The return shape now includes
`propertyMerged` so the importer UI can surface
"3 imported, 2 merged into existing properties."

Non-PROPERTY items continue to bulk-insert unchanged.

**2. Autopilot page subtitle cleanup.**

The Autopilot page header was still showing the misleading
old subtitle `"Automated content generation and scheduling"`,
which implied auto-publish. Replaced with
`"AI campaign opportunities prepared for your review"` to
match the actual product behavior.

**3. The in-Autopilot dedup remains.**

`listingDedupKey()` + `listingRichnessScore()` in the
NEW_LISTING / OPEN_HOUSE detectors stay as a defense-in-depth
layer. Legacy duplicate rows in existing workspaces still
collapse onto a single recommendation without a backfill
migration.

**Files changed:**

- `domains/studio/dataImport.service.js` — `saveImportedItems`
  now dedups PROPERTY items; new `propertyDedupKey` +
  `mergePreferRicher` helpers.
- `docs/AUTOPILOT_MVP_IMPLEMENTATION.md` — new §2a
  "Recommendation Quality" subsection.
- `tests/dataImportPropertyDedup.test.js` — 5 cases (same
  batch / cross-batch / MLS id / non-PROPERTY pass-through /
  distinct addresses don't collapse).
- web `src/app/(app)/workspaces/[clientId]/autopilot/page.tsx`
  — subtitle change.

**Tests:** API 898/898 passing; Web 272/272 passing; web
typecheck clean. No skipped tests.

**Remaining known limitations:**

- Library-level dedup is now intake-only — legacy duplicate
  rows already in a workspace's `WorkspaceDataItem` table
  are not touched. The Autopilot dedup keeps the Inbox
  correct, but the Property Library UI may still show two
  rows until a future backfill / merge tool ships.
- `propertyMerged` is returned by the service but no
  importer UI surface consumes it yet — surfacing
  "n imported, m merged" in the importer review screen is
  a small follow-up.

**Safety:** unchanged — no auto-publish path was added.

---

## 16. Spinstr05 — Trigger Expansion Completion Note

**Date:** 2026-05-18

Added four new triggers using only data the app already
tracks; deferred the one that depends on external data.

**Implemented:**

| Trigger | Source data | Why now |
|---|---|---|
| `PRICE_DROP` | `dataJson._events[].type=='price_drop'` (produced by `listingEvents.detectIngestionEvents`) with structured `{ oldPrice, newPrice, dropPercent }` payload | Re-engages buyers who passed at the higher price |
| `JUST_SOLD` | `dataJson.status=='sold'` + `_statusHistory` showing flip within 30d | Social proof + attracts future sellers |
| `STALE_LISTING` | `dataJson._events[].type=='stale_listing'` (produced by the daily `evaluateStaleListings` job) | Brings active listings back in front of buyers |
| `SEASONAL` | Built-in `SEASONAL_WINDOWS` calendar (spring buyer / summer open house / fall seller / year-end recap) | Keeps the inbox active in calmer windows without inventing market stats |

Conflict suppression: `STALE_LISTING` is skipped when an
active `NEW_LISTING` / `PRICE_DROP` / `OPEN_HOUSE` rec
already exists for the same property dedup key. `SEASONAL`
is suppressed when the run has already emitted ≥3 stronger
recs.

Idempotency: each new trigger uses the existing
`(clientId, triggerType, triggerObjectId)` unique key.
PRICE_DROP / JUST_SOLD / STALE_LISTING dedup by the
listing's normalized address (`listingDedupKey`); SEASONAL
dedups by `season:<key>:<year>`.

**Deferred:**

- `MARKET_UPDATE` — requires real local-market data (median
  price, days-on-market, inventory). The app doesn't track
  any of those. Defer rather than invent; revisit when a
  market-data integration ships.

**Per-trigger expiration windows:**

| Trigger | Window |
|---|---|
| NEW_LISTING | 14 days from listing import |
| OPEN_HOUSE | until day after event |
| PRICE_DROP | 14 days from price-drop event |
| JUST_SOLD | 30 days from sold flip |
| STALE_LISTING | 14 days from stale-listing event |
| NEW_REVIEW | 30 days from now |
| SEASONAL | end of the latest active month in the window |
| INACTIVITY_GAP | 7 days from now |

**Priority order** (applied via run order + the
`shouldReplaceTrigger` map on the FE):

OPEN_HOUSE → PRICE_DROP → NEW_LISTING (with photos) →
JUST_SOLD → NEW_REVIEW → STALE_LISTING → SEASONAL →
INACTIVITY_GAP (fallback).

**FE changes:**

- `AutopilotTriggerType` union extended with `just_sold`,
  `stale_listing`, `seasonal`, `new_review`,
  `inactivity_gap` (previously these passed through to the
  UI as untyped lowercase strings).
- `OpportunityHero.tsx` + `OpportunityQueue.tsx` ship
  dedicated icons + labels for each new type (Trophy /
  Clock / Sun / Star / Megaphone).
- The legacy `AutopilotCampaignCard.tsx` (kept for
  non-command-center surfaces) gets fallback entries too.
- `autopilotCampaignMapping.shouldReplaceTrigger` priority
  map updated to the new order.

**Tests:**

- `tests/autopilotTriggerExpansion.test.js` — 18 cases
  (seasonal calendar windows, price formatter, sold-stamp
  extractor)
- `tests/autopilotTriggerDetectors.test.js` — 11 integration
  cases (PRICE_DROP positive / negative / stale-event;
  JUST_SOLD positive / historical / active-status guards;
  STALE_LISTING positive / suppression / sold-status guard;
  SEASONAL one-per-window + soft-cap suppression)

Suites: API **932/932 passing**; Web **291/291 passing**;
web typecheck clean. No skipped tests.

**Safety:** unchanged — no auto-publish path was added.
The new triggers feed the same NEEDS_REVIEW → user-click
generate → DRAFT_GENERATED → user-click approve →
APPROVED/SCHEDULED workflow as the existing four.
