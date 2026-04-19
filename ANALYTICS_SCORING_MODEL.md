# Analytics Scoring Model

## Three-Score System

| Score | Source | Null When? |
|-------|--------|-----------|
| **qualityScore** | Internal heuristics: hooks, hashtags, CTA, body length, media presence, platform-fit | Never (always computable) |
| **observedScore** | Real engagement: relative engagement rate vs channel benchmarks | No engagement data synced |
| **compositeScore** | Weighted blend of the above | Never |

## Composite Formula

**With engagement data (mode: `weighted`):**

```
compositeScore = observedScore * 0.5 + qualityScore * 0.3 + consistencyScore * 0.2
```

**Without engagement data (mode: `internal_only`):**

```
compositeScore = qualityScore * 0.8 + consistencyScore * 0.2
```

## Quality Score Components (0-100)

| Component | Max Points | Criteria |
|-----------|-----------|---------|
| Body length | 25 | 10 base, 20 for 100-500 chars, 25 for 500+ |
| Media presence | 25 | 25 for video, 20 for image |
| CTA present | 15 | Explicit CTA or CTA keywords detected |
| Hooks present | 15 | 15 for 3+, 10 for 1-2 |
| Hashtags present | 10 | Any hashtags = 10 |
| Platform-fit length | 10 | Within platform ideal range = 10 |

## Observed Score

Relative engagement rate scaled to 0-100:

```
relativeEngagement = postEngagementRate / channelAvgEngagementRate
observedScore = clamp(round(relativeEngagement * 50), 0, 100)
```

A score of 50 means the post matched the channel average.

## Tier Classification

| Range | Tier |
|-------|------|
| 90-100 | Exceptional |
| 70-89 | Strong |
| 50-69 | Average |
| 30-49 | Below Average |
| 0-29 | Needs Attention |

## Database Columns

- `PostInsight`: `qualityScore`, `observedScore`, `compositeScore`
- `WorkspaceAnalytics`: `avgQualityScore`, `avgObservedScore`, `avgCompositeScore`
- `AnalyticsSnapshot`: `avgQualityScore`, `avgObservedScore`, `avgCompositeScore`
- `DataItemPerformance`: `avgQualityScore`, `avgObservedScore`, `avgCompositeScore`
- `BlueprintPerformance`: `avgQualityScore`, `avgObservedScore`, `avgCompositeScore`

## API Response Shape

**Summary:**
```json
{
  "qualityScore": 72.3,
  "observedScore": 58.1,
  "compositeScore": 65.4,
  "engagementRate": 0.034,
  "totalReach": 12500,
  "postsPublished": 42,
  "dataCoverage": "partial"
}
```

**Post objects:**
```json
{
  "id": "...",
  "qualityScore": 80,
  "observedScore": 45,
  "compositeScore": 62
}
```

**Score breakdown (post detail):**
```json
{
  "qualityScore": 80,
  "observedScore": 45,
  "compositeScore": 62,
  "tier": "average",
  "mode": "weighted",
  "components": {
    "engagement": { "raw": 45, "weight": 0.5, "weighted": 23 },
    "quality": { "raw": 80, "weight": 0.3, "weighted": 24 },
    "consistency": { "raw": 75, "weight": 0.2, "weighted": 15 }
  },
  "explanation": "Engagement (23/50) + Quality (24/30) + Consistency (15/20) = 62"
}
```
