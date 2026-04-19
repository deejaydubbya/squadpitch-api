# Post Metric Snapshots

Append-only time-series table that captures a snapshot of every post's metrics on each sync cycle. This preserves historical data that was previously lost when `PostMetrics` was overwritten.

## Model

`PostMetricSnapshot` — one row per post per sync.

| Field | Type | Notes |
|-------|------|-------|
| `draftId` | String | FK → Draft |
| `clientId` | String | FK → Client |
| `channel` | Channel | Platform enum |
| `snapshotAt` | DateTime | Timestamp of the sync (`fetchedAt`) |
| `impressions` | Int | |
| `reach` | Int | |
| `engagements` | Int | |
| `clicks` | Int | |
| `saves` | Int | |
| `shares` | Int | |
| `comments` | Int | |
| `likes` | Int | |
| `engagementRate` | Float? | |

### Dedup strategy

`@@unique([draftId, snapshotAt])` — if the same sync retries with the same `fetchedAt` timestamp, it upserts instead of duplicating. The existing 1-hour cooldown (`MIN_SYNC_INTERVAL_MS`) prevents rapid-fire syncs in normal operation.

## API Endpoints

### Post detail (enriched)

```
GET /api/v1/workspaces/:clientId/analytics/posts/:postId
```

Response now includes a `growth` field showing deltas between the two most recent snapshots:

```json
{
  "...existing fields...",
  "growth": {
    "impressionsDelta": 1250,
    "reachDelta": 800,
    "engagementsDelta": 45,
    "clicksDelta": 12,
    "engagementRateDelta": 0.002,
    "periodHours": 24
  }
}
```

Returns `"growth": null` when fewer than 2 snapshots exist.

### Post metric history (new)

```
GET /api/v1/workspaces/:clientId/analytics/posts/:postId/history
```

Returns the full time-series plus growth:

```json
{
  "history": [
    {
      "snapshotAt": "2026-04-18T12:00:00.000Z",
      "impressions": 500,
      "reach": 300,
      "engagements": 25,
      "clicks": 8,
      "saves": 3,
      "shares": 2,
      "comments": 5,
      "likes": 15,
      "engagementRate": 0.05
    }
  ],
  "growth": { "..." }
}
```

Default limit: 50 snapshots per post, ordered chronologically.

## Testing

1. `npx prisma validate` — schema is valid
2. Sync a published draft → `post_metric_snapshots` has 1 row
3. Wait for cooldown (or bypass), sync again → 2 rows, both preserved
4. Retry same sync (same `fetchedAt`) → upsert, still 2 rows (no duplicate)
5. `GET .../posts/:postId` returns `growth: null` (1 snapshot), then `growth: {...}` after 2nd sync
6. `GET .../posts/:postId/history` returns ordered array
7. PostDetailModal shows delta badges next to metrics when growth data exists
8. Collapsible "Metric History" section loads lazily on expand
