# Timezone-Aware Analytics

## Timezone Source

The workspace timezone is stored on the `Client` model as `Client.timezone` (IANA string, e.g. `"America/New_York"`). Defaults to `"UTC"` when not set.

Fetched via `getClientTimezone(clientId)` from `lib/timezone.js`.

## What Changed

### Already Timezone-Aware (no changes needed)
- **Publishing trend** (`buildPublishingTrend`) — already used `getLocalDateString(date, timezone)` for day bucketing
- **Posting time bucket** (`getPostingTimeBucket` in normalization) — already used `getLocalHour(date, timezone)`

### Fixed: UTC → Local Timezone

| File | Function | What Changed |
|------|----------|-------------|
| `insights.service.js` | `consistencyInsight()` | Week grouping now uses `getLocalWeekKey(date, timezone)` instead of UTC `toISOString().slice(0,10)` |
| `recommendations.service.js` | `cadenceRecommendation()` | Same fix — week grouping uses local timezone |
| `analytics.service.js` | `getClientAnalytics()` | 14-day series uses `getLocalDateString()` instead of UTC `toISOString().slice(0,10)` |
| `analyticsOverview.service.js` | `getAnalyticsOverview()` | Passes `timezone` to `generateInsights()` and `generateRecommendations()` |

### Response Change

The analytics overview response now includes a `timezone` field at the top level, so the frontend can display which timezone is being used.

### Frontend

When the workspace timezone is set to something other than UTC, a small label appears under the page title: "Times shown in America/New York".

## Helpers

`lib/timezone.js` provides:

| Helper | Purpose |
|--------|---------|
| `getLocalHour(date, tz)` | Local hour (0–23) |
| `getLocalDateString(date, tz)` | Local YYYY-MM-DD |
| `getLocalMidnight(tz)` | Today's midnight in tz as UTC Date |
| `getLocalWeekKey(date, tz)` | Start-of-week (Sunday) YYYY-MM-DD in local tz |
| `getClientTimezone(clientId)` | Fetch tz from Client record |

All helpers use `Intl.DateTimeFormat` (built into Node.js, zero dependencies) and fall back to UTC on invalid timezone input.

## How Generators Receive Timezone

The `generateInsights()` and `generateRecommendations()` functions accept an optional `timezone` parameter. They pass it to all generators via `generators.map((gen) => gen(rows, timezone))`. Generators that don't need timezone simply ignore the second argument. Only `consistencyInsight` and `cadenceRecommendation` use it for week grouping.
