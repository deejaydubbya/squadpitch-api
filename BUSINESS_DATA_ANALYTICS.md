# Business Data Analytics

## Overview

Business data analytics measures which imported data, blueprints/templates, and source items lead to the best content outcomes. It answers: which data types perform best, which blueprints are most effective, which data is underused, and whether data freshness correlates with performance.

## Source Dimensions Now Measurable

| Dimension | What It Shows |
|-----------|---------------|
| **Data Item Type** | Which categories (TESTIMONIAL, CASE_STUDY, PROPERTY, etc.) produce the highest-scoring content |
| **Blueprint/Template** | Which content blueprints (SOCIAL_PROOF, EDUCATION, etc.) lead to strongest engagement |
| **Usage Volume** | How many drafts each data item has generated, and how many were published |
| **Freshness** | Whether recently imported data (< 7 days) outperforms aged data (30+ days) |
| **Underused Items** | Data items that were imported but never used in content generation |
| **Stale Items** | Previously used data items not touched in 30+ days |

## How Performance Is Attributed Back to Source Data

```
Import Data → WorkspaceDataItem created
                    ↓
Generate Content → Draft created
                 → GeneratedContentSource(draftId, dataItemId, blueprintId) created
                 → dataItem.usageCount incremented
                    ↓
Publish & Sync  → Platform metrics fetched → NormalizedMetric
                → AI scoring → PostInsight
                    ↓
Performance Calc → updatePerformanceForDraft() triggered
                 → Finds all GeneratedContentSource links for this draft
                 → Aggregates all drafts from same dataItem → DataItemPerformance
                 → Aggregates all drafts from same blueprint → BlueprintPerformance
                    ↓
Analytics View  → businessDataAnalytics.service.js reads DataItemPerformance
                  and BlueprintPerformance to build overview section
```

The key attribution table is `GeneratedContentSource`, which links every generated draft back to its source data item and the blueprint used. Performance metrics flow back automatically when platform metrics sync.

## Backend Service

`businessDataAnalytics.service.js` builds on existing infrastructure:

- **Reuses**: `WorkspaceDataItem`, `DataItemPerformance`, `BlueprintPerformance`, `GeneratedContentSource` (all existing models)
- **No schema changes needed**
- **Queries**: Active data items with their cached performance, blueprints used by the client with their performance
- **Aggregates**: by type, by blueprint, by freshness bucket, top performers, underused items

## Response Shape

```js
{
  totalDataItems,          // active items in workspace
  totalUsed,               // items with usageCount > 0
  totalUnused,             // items never used
  totalStale,              // used but not in 30+ days
  totalDraftsFromData,     // drafts generated from data items
  totalPublishedFromData,  // of those, how many published

  byType: [{ type, itemCount, totalDrafts, totalPublished, avgScore, avgEngagement }],
  byBlueprint: [{ blueprintId, blueprintName, category, totalDrafts, totalPublished, avgScore, avgEngagement }],
  byFreshness: [{ bucket, label, itemCount, avgScore }],
  topItems: [{ id, title, type, usageCount, totalPublished, avgScore, avgEngagement }],
  underusedItems: [{ id, title, type, usageCount, daysSinceCreation }],

  hasData
}
```

## Integration

Added to `analyticsOverview.service.js` → `sections.businessData`. No new API routes needed. Business data section is not range-filtered (it shows all-time performance) because `DataItemPerformance` aggregates across all published drafts.

## Frontend

Section 8 "Business Data" on the analytics page includes:
- 4 metric cards: Data Items (with used count), Unused, Drafts Generated (with published count), Stale
- Data type performance chart (horizontal bar, cyan fill)
- Blueprint performance chart (horizontal bar, cyan fill)
- Two-column grid: Top Data Items (ranked with type badges, scores, engagement) + Underused Data (with days-since-creation)
