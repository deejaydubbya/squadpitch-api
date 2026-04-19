# Analytics Architecture

> Reflects the actual implementation as of April 2026.

---

## 1. Data Model

### Core Models

| Model | Key | Purpose |
|-------|-----|---------|
| **RawMetric** | `draftId` (non-unique) | Raw API responses from platform (JSON blob). Multiple rows possible per draft for history. |
| **PostMetrics** | `draftId` (unique) | Current-state engagement snapshot: impressions, reach, engagement, clicks, saves, shares, comments, likes, engagementRate. Has `lastSyncedAt` for cooldown. |
| **PostMetricSnapshot** | `draftId + snapshotAt` (unique) | Daily time-series of per-post metrics. Deduped by date — one row per post per day. Enables growth charts. |
| **NormalizedMetric** | `draftId` (unique) | Platform-normalized engagement: impressions, reach, engagements, clicks, engagementRate, `relativeEngagementRate` (vs channel avg). |
| **PostInsight** | `draftId` (unique) | AI-computed assessment: qualityScore, observedScore, compositeScore, plus content metadata (contentType, hookType, sentiment, lengthBucket, mediaType, postingTimeBucket, recommendationTags). |
| **WorkspaceAnalytics** | `clientId` (unique) | Pre-computed workspace aggregates: avg scores, totals, best platform/content/media. Recalculated by worker. |
| **AnalyticsSnapshot** | `clientId + snapshotDate` (unique) | Daily workspace-level time-series. Created at local midnight via `createDailySnapshot()`. |

### Business Data Performance

| Model | Key | Purpose |
|-------|-----|---------|
| **DataItemPerformance** | `dataItemId` (unique) | Cached aggregates for a data item: totalDrafts, totalPublished, avgEngagement, avg scores. Updated fire-and-forget after publish/sync. |
| **BlueprintPerformance** | `blueprintId` (unique) | Same structure for content templates. Answers "Which blueprint generates the best content?" |

### Conversion Tracking

| Model | Key | Purpose |
|-------|-----|---------|
| **TrackableLink** | `shortCode` (unique) | Maps draft → destination URL with UTM params. `clickCount` incremented atomically on redirect. |
| **ConversionEvent** | `id` | Generic conversion event (LINK_CLICK, FORM_SUBMISSION, CALL_BOOKED, CONTACT_CLICK, LISTING_INQUIRY, CRM_LEAD, CUSTOM). Privacy: IP/UA stored as SHA-256 hashes only. |

### Campaign Fields (on Draft)

No separate model — campaign data lives on Draft: `campaignId`, `campaignName`, `campaignType`, `campaignDay`, `campaignOrder`, `campaignTotal`. Indexed on `[clientId, campaignId]`.

### Autopilot Fields (on Draft)

Identified via `createdBy: "system:autopilot"` and/or `warnings` array containing `"autopilot: true"`, `"autopilot_trigger: <type>"`, etc.

---

## 2. Sync Pipeline

**File:** `metricsSyncService.js`

```
syncMetricsForDraft(draftId)
 ├─ Load draft (must be PUBLISHED with externalPostId)
 ├─ Check cooldown (1 hour minimum between syncs)
 ├─ Get ChannelConnection (decrypted tokens)
 ├─ Auto-refresh token if expiring within 1 hour
 ├─ Fetch raw metrics via platform adapter
 │   ├─ Instagram: likes + comments + saves = engagements
 │   ├─ TikTok: likes + comments + shares; views = impressions
 │   ├─ LinkedIn: reactions + comments + reposts = engagements
 │   ├─ X/Twitter: likes + retweets + replies = engagements
 │   └─ Facebook/YouTube: reactions + comments + shares = engagements
 ├─ Store in RawMetric (findFirst + update/create pattern)
 ├─ Normalize → NormalizedMetric (channel-specific rules)
 ├─ Compute relative engagement rate vs channel benchmarks
 ├─ Compute scores → update PostInsight
 ├─ Upsert PostMetrics (current snapshot)
 ├─ Upsert PostMetricSnapshot (daily time-series, deduped)
 └─ Fire-and-forget: updatePerformanceForDraft (DataItem + Blueprint perf)
```

**Entry points:**

| Function | Purpose |
|----------|---------|
| `syncMetricsForDraft(draftId)` | Sync a single post |
| `getEligibleDraftsForSync({ batchSize })` | Query posts ready for sync (never-synced first, then oldest) |
| `getMetricsSyncStatus(clientId)` | Returns lastSyncedAt, syncedPostCount, pendingSyncCount |
| `enqueuePostPublishSync(draftId, delayMs)` | Queue sync 5 min after publish |

---

## 3. Current Metrics vs Historical Snapshots

| Layer | Model | Granularity | Use Case |
|-------|-------|-------------|----------|
| **Current** | PostMetrics | Latest values, updated on each sync | Dashboard cards, quick lookups |
| **Historical** | PostMetricSnapshot | 1 row per post per day | Growth charts in PostDetailModal |
| **Normalized** | NormalizedMetric | Latest, platform-adjusted | Cross-platform comparison, scoring |
| **Raw** | RawMetric | Full API response JSON | Debugging, future re-processing |

`PostMetricSnapshot` deduplicates by `draftId + snapshotAt` (date, not timestamp). Re-syncing a post on the same day updates the existing row.

Growth deltas are computed by `getPostMetricGrowth(draftId)` in `postMetricHistory.service.js`.

---

## 4. Scoring Model

### Quality Score (0–100) — Internal Heuristics

Computed by `extractInternalSignals(draft)` in `normalization.service.js`:

| Component | Max | Criteria |
|-----------|-----|----------|
| Body length | 25 | 10 base, 20 for 100–500 chars, 25 for 500+ |
| Media | 25 | 25 video, 20 image, 0 none |
| CTA | 15 | Explicit CTA or CTA keywords |
| Hooks | 15 | 15 for 3+, 10 for 1–2 |
| Hashtags | 10 | Any = 10, none = 0 |
| Platform fit | 10 | Within ideal length range = 10 |

### Observed Score (0–100) — Relative Engagement

Computed by `computePerformanceScore()` in `performanceScoring.service.js`:

```
relativeEngagement = postEngagementRate / channelAvgEngagementRate
observedScore = clamp(relativeEngagement × 50, 0, 100)
```

50 = matched channel average. 75+ = outperformed by 50%+.

### Composite Score (0–100) — Weighted Blend

**With engagement data:**
```
composite = observed × 0.5 + quality × 0.3 + consistency × 0.2
```

**Without engagement data (internal-only):**
```
composite = quality × 0.8 + consistency × 0.2
```

### Consistency Score (0–100)

Groups published posts by local date (timezone-aware), measures coefficient of variation. Perfect daily cadence = 100. Penalizes <3 posts in window.

### Tier Classification

| Range | Tier |
|-------|------|
| 90–100 | exceptional |
| 70–89 | strong |
| 50–69 | average |
| 30–49 | below_average |
| 0–29 | needs_attention |

---

## 5. Benchmark Model

**File:** `benchmark.service.js`

Four-level hierarchy, each with avgScore, avgEngagementRate, avgReach, sampleSize, confidence:

1. **Workspace** — all published posts in range
2. **By Channel** — per platform (Instagram, LinkedIn, etc.)
3. **By Content Type** — per content category (educational, promotional, etc.)
4. **By Media Type** — per format (image, video, carousel, text)

**Confidence levels:** high (10+ posts), medium (5–9), low (3–4), insufficient (<3).

`compareToBenchmark(value, benchmark, metric)` returns delta, label (above/below/at), confidence, unit.

Post detail includes benchmark comparisons: vs workspace, vs channel, vs content type.

---

## 6. Business Data Analytics

**File:** `businessDataAnalytics.service.js`

Queries `WorkspaceDataItem` with `DataItemPerformance` and `ContentBlueprint` with `BlueprintPerformance`. No range filter — uses all-time cached performance tables.

Returns:
- **byType** — performance grouped by data type (TESTIMONIAL, CASE_STUDY, STAT, etc.)
- **byBlueprint** — performance per content template
- **byFreshness** — items bucketed by age (<7d, 7–30d, 30d+)
- **topItems** — best performing data items by engagement
- **underusedItems** — unused or low-usage items with high priority

Performance tables updated fire-and-forget via `dataAnalytics.service.js` after publish/sync.

---

## 7. Campaign Analytics

**File:** `campaignAnalytics.service.js`

Queries published drafts with non-null `campaignId` in range. All aggregation in-memory.

Returns:
- **Summary**: totalCampaigns, completedCampaigns, avgCompletionRate, totalReach, avgScore
- **byType**: grouped by campaignType (just_listed, open_house, price_drop, just_sold, series)
- **byDay**: performance by campaign day position (Day 1 vs Day 3 across all campaigns)
- **topCampaigns / worstCampaigns**: top/bottom 5 ranked by observedScore (compositeScore fallback)

Completion = publishedCount / campaignTotal.

---

## 8. Autopilot Analytics

**File:** `autopilotAnalytics.service.js`

Identifies autopilot drafts via `warnings: { has: 'autopilot: true' }` OR `createdBy: 'system:autopilot'`. Uses `createdAt` filter (not `publishedAt`) to capture unpublished drafts.

Returns:
- **Counts**: generated, published, approved, rejected, pending
- **Rates**: approvalRate, publishRate
- **Comparison**: avgAutopilotScore vs avgManualScore, avgAutopilotEngagement vs avgManualEngagement
- **byChannel**: per-platform breakdown
- **byTrigger**: breakdown by trigger type (new_listing, price_drop, etc.)
- **recentActivity**: latest 20 autopilot drafts with status and metadata

`parseAutopilotMeta(warnings)` extracts trigger, reason, mode, asset, angle from the warnings array.

---

## 9. Conversion Analytics

**Files:** `conversionAnalytics.service.js`, `conversionEvent.service.js`

Aggregates from `ConversionEvent` and `TrackableLink`:
- **byType**: counts per event type (LINK_CLICK, FORM_SUBMISSION, etc.)
- **byChannel**: counts per platform
- **topDrafts**: top 5 posts by conversion count
- **conversionRate**: totalConversions / totalPublishedPosts
- **activeLinks**: count of active trackable links

---

## 10. Trust, Coverage & Diagnostics

**File:** `analyticsDiagnostics.service.js`

Merged into the `coverage` section of the analytics overview response (no separate section).

| Signal | Source |
|--------|--------|
| **Per-channel coverage** | Published vs synced counts from Draft + NormalizedMetric |
| **Connection health** | ChannelConnection status, displayName, tokenExpiresAt, lastError |
| **Freshness warnings** | Stale syncs (24h+), broken connections, unconnected channels |
| **Overall health** | healthy (≥50% coverage, no broken connections), degraded (<50% or broken), unhealthy (0% with posts) |

### Coverage States

| State | Condition |
|-------|-----------|
| full | All published posts have NormalizedMetric |
| partial | Some synced, rest use PostInsight only |
| internal_only | No platform metrics synced yet |

---

## 11. Frontend Analytics Page

**File:** `src/app/(app)/workspaces/[clientId]/analytics/page.tsx`

9 sections, all served from a single endpoint. Range selector: 7d / 30d / 90d / all.

| # | Section | Badge | isEmpty Condition | Key Components |
|---|---------|-------|-------------------|----------------|
| 1 | Distribution | — | No reach data and no trend | PublishingTrendChart, PlatformBreakdownChart |
| 2 | Engagement | — | No scored posts | TopPostsList (top + worst), PostDetailModal |
| 3 | Content Intelligence | — | No insights, recs, or content types | InsightCards, ContentTypeBreakdownChart, RecommendationCards |
| 4 | Coverage & Trust | — | Never empty | CoverageMeter (per-channel bars, connection health, warnings) |
| 5 | Conversions | Measured | `!hasData` | ConversionsByTypeChart, ConversionsByChannelChart, TopConvertingPosts |
| 6 | Campaigns | Measured | `!hasData` | CampaignTypeChart, CampaignDayChart, TopCampaignsList |
| 7 | Autopilot | AI | `!hasData` | AutopilotVsManualChart, AutopilotTriggerChart, AutopilotActivityList |
| 8 | Business Data | Data | `!hasData` | DataTypePerformanceChart, BlueprintPerformanceChart, TopDataItemsList |
| 9 | Benchmarks | — | `!hasData` | BenchmarkSummary (workspace/channel/type tables) |

### Shared Components

- `AnalyticsSection` — wrapper with title, badge, collapsible empty state
- `MetricCard` — KPI card (value, label, helper text, color)
- `RangeSelector` — 7d / 30d / 90d / all toggle
- `SyncStatusIndicator` — last sync time, pending count
- `ScoreBadge` — color-coded tier badge

### Timezone Display

When the workspace timezone is non-UTC, a label appears: "Times shown in America/New York".

---

## 12. API Endpoints

| Method | Path | Handler |
|--------|------|---------|
| GET | `/workspaces/:id/analytics` | `getClientAnalytics` — admin counts |
| GET | `/workspaces/:id/analytics/overview` | `getAnalyticsOverview` — full 9-section response |
| GET | `/workspaces/:id/analytics/posts/:postId` | `getPostDetail` — single post + scores + benchmarks |
| GET | `/workspaces/:id/analytics/posts/:postId/history` | `getPostMetricHistory` — time-series snapshots |
| GET | `/workspaces/:id/analytics/insights` | `generateInsights` — standalone insights |

All analytics sections are returned from the single `/overview` endpoint via `Promise.all` with `.catch()` fallbacks. No section failure blocks the response.

---

## 13. Service File Map

| File | Purpose |
|------|---------|
| `analyticsOverview.service.js` | Main orchestrator — builds all 9 sections |
| `analytics.service.js` | Admin dev portal analytics (draft counts) |
| `workspaceAnalytics.service.js` | Pre-computed aggregates + daily snapshots |
| `metricsSyncService.js` | Platform metric sync pipeline |
| `normalization.service.js` | Platform-specific normalization + internal signals |
| `performanceScoring.service.js` | Composite scoring + consistency + benchmarks |
| `classification.service.js` | Content type, hook type, sentiment, length/time buckets |
| `postMetricHistory.service.js` | Time-series queries + growth deltas |
| `insights.service.js` | Insight generators (11 types) |
| `recommendations.service.js` | Recommendation generators (8 types) |
| `benchmark.service.js` | Workspace-local benchmarks (4-level hierarchy) |
| `analyticsDiagnostics.service.js` | Coverage, connection health, freshness warnings |
| `conversionAnalytics.service.js` | Conversion section aggregation |
| `conversionEvent.service.js` | Conversion event queries |
| `campaignAnalytics.service.js` | Campaign aggregation + ranking |
| `autopilotAnalytics.service.js` | Autopilot vs manual comparison |
| `businessDataAnalytics.service.js` | Data item/blueprint performance |
| `dataAnalytics.service.js` | Fire-and-forget performance updates |
| `lib/timezone.js` | Timezone helpers (getLocalHour, getLocalDateString, getLocalWeekKey, getClientTimezone) |

---

## 14. Extension Points

- **ConversionEvent types** — add new enum values (e.g. `WEBSITE_VISIT`) without schema migration (metadata JSON handles type-specific fields)
- **Benchmark levels** — add per-hashtag or per-hook-type benchmarks by extending `getWorkspaceBenchmarks()`
- **Insight/recommendation generators** — add a function to the `generators` array in insights/recommendations services
- **New analytics sections** — add a service, call from `Promise.all` in overview, add to `sections` object, create frontend component
- **PostMetricSnapshot** — already supports historical charts; can power "engagement decay curves" or "viral detection" without schema changes
- **RawMetric** — non-unique on draftId by design; supports multi-row history for re-processing or auditing

---

## 15. Known Gaps / Next Likely Steps

- **Scheduled sync worker** — `getEligibleDraftsForSync()` exists but no cron/worker calls it on a schedule yet; currently sync is triggered on-demand or post-publish
- **Cross-workspace benchmarks** — benchmarks are workspace-local only; industry-level benchmarks would require aggregation across workspaces
- **Engagement decay curves** — PostMetricSnapshot data exists but no chart renders multi-day metric evolution for a single post
- **A/B testing** — no mechanism to split-test caption variants and compare performance
- **Attribution depth** — conversions attribute to a single post; multi-touch attribution (user saw 3 posts before converting) is not tracked
- **Real-time sync** — platform webhooks (where available) could replace polling for faster metric updates
- **Export** — no CSV/PDF export of analytics data

---

## Architecture Summary

- **Single endpoint** (`/analytics/overview`) returns all 9 sections via `Promise.all` with independent `.catch()` fallbacks
- **Three-score system**: quality (AI heuristics) → observed (engagement vs benchmarks) → composite (weighted blend, degrades gracefully without engagement data)
- **Timezone-aware**: all date grouping uses workspace `Client.timezone` via `Intl.DateTimeFormat` helpers
- **Fire-and-forget performance updates**: DataItem/Blueprint performance cached tables updated async after sync
- **Privacy-first conversions**: IP/UA stored as SHA-256 hashes, never raw PII
- **Lazy backfill**: first analytics page load triggers PostInsight creation if none exist
- **Daily snapshots**: workspace-level time-series created at local midnight for trend charts
- **No separate routes per section**: all analytics data flows through the overview service orchestrator
- **Relative benchmarking**: all engagement scoring is relative to channel/type/media averages — a 2% rate is "strong" on LinkedIn but "weak" on TikTok
- **Coverage transparency**: users see exactly which posts have real metrics vs AI-only assessment, per channel
