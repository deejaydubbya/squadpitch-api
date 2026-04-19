# Analytics Pipeline Audit — 2026-04-19

## Issues Found & Fixed

### 1. Schema field mismatch (CRITICAL — runtime failure)
- **File:** `prisma/schema.prisma` line 743
- **Bug:** `RawMetric.dataJson` in schema vs `rawDataJson` in service code → Prisma throws at runtime
- **Fix:** Renamed schema field to `rawDataJson` + migration to rename column

### 2. Upsert on non-unique field (CRITICAL — runtime failure)
- **File:** `domains/studio/metricsSyncService.js` lines 84-98
- **Bug:** `prisma.rawMetric.upsert({ where: { draftId } })` fails because `draftId` is not `@unique`
- **Fix:** Replaced with `findFirst` + `update`/`create` pattern (preserves future snapshot model)

### 3. Wrong relation name in orderBy
- **File:** `domains/studio/metricsSyncService.js` line 192
- **Bug:** `orderBy: { postMetrics: { lastSyncedAt: "asc" } }` — relation is `metrics`, not `postMetrics`
- **Fix:** Changed to `{ metrics: { lastSyncedAt: "asc" } }`

### 4. bestContentType / bestMediaType picked by count instead of performance
- **Files:** `workspaceAnalytics.service.js` lines 53-67, `analyticsOverview.service.js` `getBestGroup()` lines 208-215
- **Bug:** Most-frequent type was labelled "best" — a type posted once with score 95 lost to a type posted 10x with score 40
- **Fix:** Now picks by highest average `performanceScore`

### 5. Null-inflated totalReach / totalEngagements
- **File:** `workspaceAnalytics.service.js` lines 30-31, 109-110
- **Bug:** `d.normalizedMetric?.reach ?? 0` coerces nulls (no data) to 0, inflating sums with phantom zeros
- **Fix:** `.filter((r) => r != null)` before summing — only real values contribute

### 6. Daily snapshots never created
- **File:** `workers/recalculateAnalyticsWorker.js`
- **Bug:** `createDailySnapshot()` existed but was never called from the worker
- **Fix:** Added call after each successful `recalculateWorkspaceAnalytics()` (with `.catch()` guard)

### 7. UTC-only date/time grouping — no workspace timezone awareness
- **Files:** `classification.service.js`, `analyticsOverview.service.js`, `workspaceAnalytics.service.js`, `performanceScoring.service.js`
- **Bug:** All date grouping and time-of-day classification used UTC — a 9am EST post was classified as "midday" (14:00 UTC); publishing trends grouped by UTC date boundaries
- **Fix:**
  - Added `timezone` field to `Client` model (default `"UTC"`, IANA format e.g. `"America/New_York"`)
  - Created `lib/timezone.js` with `getLocalHour()`, `getLocalDateString()`, `getLocalMidnight()`, `getClientTimezone()` using `Intl.DateTimeFormat` (no dependencies)
  - `getPostingTimeBucket()` now uses local hour instead of UTC hour
  - `buildPublishingTrend()` groups by local date instead of UTC date
  - `createDailySnapshot()` snapshots by local midnight instead of UTC midnight
  - `getPostingConsistencyScore()` groups by local date instead of UTC date
  - Threaded timezone through: `classifyContent()`, `computeAndSaveInsight()`, `reclassifyClientInsights()`, `backfillClientInsights()`, `syncMetricsForDraft()`

### 8. Dead code in normalization.service.js
- **File:** `domains/studio/normalization.service.js` lines 157-201
- **Bug:** `CONTENT_KEYWORDS`, `inferContentType`, `inferHookType`, `getLengthBucket`, `getPostingTimeBucket` were defined but never called — `computeAndSaveInsight` uses `classifyContent` from `classification.service.js` instead
- **Fix:** Removed all 5 dead definitions

## API Contract Impact
- All response shapes unchanged (same field names, same types)
- `bestContentType` / `bestMediaType` values may differ (performance-based vs frequency-based)
- `totalReach` / `totalEngagements` may be lower (no longer inflated by nulls)
- `postingTimeBucket` values may change for clients who set a non-UTC timezone
- Publishing trend date keys may shift by ±1 day for non-UTC clients
- No frontend changes needed

## Deployment Order
1. Apply migrations: `npx prisma migrate deploy` (renames column + adds timezone field)
2. Deploy code (all changed files)
3. Optionally set client timezones: `UPDATE clients SET timezone = 'America/New_York' WHERE ...`

## New Files
- `lib/timezone.js` — timezone utility helpers (4 exported functions, no dependencies)
- `prisma/migrations/20260419000000_rename_dataJson_to_rawDataJson/migration.sql`
- `prisma/migrations/20260419000001_add_client_timezone/migration.sql`

## Changed Files
1. `prisma/schema.prisma` — `RawMetric.dataJson` → `rawDataJson`, `Client.timezone` added
2. `domains/studio/metricsSyncService.js` — RawMetric findFirst/update pattern, orderBy fix, timezone threading
3. `domains/studio/workspaceAnalytics.service.js` — null filtering, timezone-aware snapshots
4. `domains/studio/analyticsOverview.service.js` — getBestGroup by performance, timezone-aware trend
5. `domains/studio/performanceScoring.service.js` — timezone-aware consistency grouping
6. `domains/studio/classification.service.js` — timezone-aware posting time bucket
7. `domains/studio/normalization.service.js` — dead code removed, timezone threading
8. `workers/recalculateAnalyticsWorker.js` — daily snapshot creation added

## Remaining Limitations
- `RawMetric` rows accumulate per draft (one row updated per sync, but no cleanup of orphans)
- `createDailySnapshot` overwrites the same day's row on re-run (idempotent, but no intra-day history)
- Performance score ties in bestContentType/bestMediaType are broken arbitrarily (first in sort order)
- Client timezone defaults to UTC — existing clients need manual update or a UI setting
- `getClientTimezone()` makes a DB query per call — could benefit from caching if called in tight loops

## Verification Checklist
- [ ] `npx prisma validate` passes
- [ ] Sync same draft twice → only 1 RawMetric row (updated, not duplicated)
- [ ] `getEligibleDraftsForSync()` returns results without Prisma error
- [ ] With mixed content types, bestContentType reflects highest avg score
- [ ] With sparse engagement data, totalReach only sums non-null values
- [ ] After recalc-client job, AnalyticsSnapshot row exists for today
- [ ] Set client timezone to non-UTC → postingTimeBucket reflects local hour
- [ ] Publishing trend dates match the client's local calendar
