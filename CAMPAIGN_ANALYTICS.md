# Campaign Analytics

## Overview

Campaign analytics aggregates post-level metrics into campaign-level views. Campaigns are identified by the `campaignId` field on the `Draft` model, populated automatically when content is created as part of listing campaigns (just_listed, open_house, price_drop, just_sold) or content series.

## How Campaigns Are Identified

The Draft model has these campaign fields (all nullable):
- `campaignId` — unique identifier for the campaign
- `campaignName` — human-readable name
- `campaignType` — category (just_listed, open_house, price_drop, just_sold, series)
- `campaignDay` — position in sequence (1, 2, 3...)
- `campaignOrder` — ordering within a day
- `campaignTotal` — total planned posts in the campaign

An existing `@@index([clientId, campaignId])` supports efficient querying.

## Metrics Aggregated

Two existing metric models are aggregated:
- **NormalizedMetric** — platform-fetched data: impressions, reach, engagements, engagementRate
- **PostInsight** — AI-generated scores: qualityScore, observedScore, compositeScore

## Aggregation Logic

### Completion Rate
`completionRate = publishedPostCount / campaignTotal`

A campaign is "completed" when `publishedPostCount >= campaignTotal`. The `avgCompletionRate` averages this ratio across all campaigns that have a non-zero `campaignTotal`.

### Campaign Scoring
Campaigns are ranked by `observedScore` (platform-validated) with fallback to `compositeScore` (AI-estimated). This matches how individual posts are ranked in the engagement section.

### Day Performance
Day-level stats aggregate across all campaigns to show whether certain positions in a campaign sequence systematically perform better. For example, Day 1 posts may get more engagement than Day 5 posts across all campaigns.

### Type Comparison
Groups campaigns by `campaignType` to compare performance between listing types and content series.

## Range Filtering

The `since` parameter filters by `publishedAt`, consistent with all other analytics sections. A campaign may show partial data if some posts fall outside the selected date range.

## Integration

The campaign analytics service (`campaignAnalytics.service.js`) is called by `analyticsOverview.service.js` and its results are included in the `sections.campaigns` field of the overview response. No new API routes are needed.

## Response Shape

```js
{
  totalCampaigns,          // count of distinct campaignIds
  completedCampaigns,      // where publishedCount >= campaignTotal
  avgCompletionRate,       // avg(publishedCount / campaignTotal)
  totalCampaignReach,      // sum of reach across all campaign posts
  totalCampaignImpressions,
  avgCampaignScore,        // avg compositeScore across all campaign posts

  byType: [{ campaignType, campaignCount, totalPosts, avgScore, avgEngagementRate, avgCompletionRate }],
  byDay: [{ day, postCount, avgScore, avgEngagementRate }],
  topCampaigns: [{ campaignId, campaignName, campaignType, postCount, campaignTotal, completionRate, avgScore, avgEngagementRate, totalReach }],
  worstCampaigns: [],      // same shape, bottom 5

  hasData                  // totalCampaigns > 0
}
```
