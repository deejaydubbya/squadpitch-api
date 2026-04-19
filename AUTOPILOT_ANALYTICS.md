# Autopilot Analytics

## Overview

Autopilot analytics tracks what Autopilot is doing and how effective it is compared to manual content creation. It aggregates across all autopilot-generated drafts to show generation volume, approval/publish rates, performance comparison, trigger breakdown, and recent activity.

## How Autopilot Drafts Are Identified

Autopilot drafts are identified by any of:
- `Draft.warnings[]` containing `"autopilot: true"`
- `Draft.createdBy` = `"system:autopilot"`
- `Draft.createdBy` = `"system:auto_generate"`

No schema changes were needed — all metadata was already stored.

## Existing Metadata Reused

| Field | Source | Purpose |
|-------|--------|---------|
| `Draft.warnings[]` | Existing | Autopilot flag, trigger, reason, mode, asset, angle |
| `Draft.createdBy` | Existing | `"system:autopilot"` or `"system:auto_generate"` |
| `Draft.status` | Existing | DRAFT/PENDING_REVIEW/APPROVED/SCHEDULED/PUBLISHED/REJECTED |
| `Draft.approvedBy` / `approvedAt` | Existing | Approval tracking |
| `Draft.rejectedReason` | Existing | Rejection tracking |
| `NormalizedMetric` | Existing | Platform engagement data |
| `PostInsight` | Existing | AI-generated quality/composite scores |

No new fields were added.

## What Autopilot Analytics Includes

### Volume Metrics
- **totalGenerated** — all autopilot drafts created in range
- **totalPublished** — autopilot drafts that reached PUBLISHED status
- **totalApproved** — drafts approved (by status or approvedBy field)
- **totalRejected** — drafts rejected (by status or rejectedReason field)
- **totalPending** — drafts still in DRAFT or PENDING_REVIEW

### Rate Metrics
- **approvalRate** — `approved / (approved + rejected)` — only counts decided drafts
- **publishRate** — `published / totalGenerated`

### Performance Comparison (Autopilot vs Manual)
- **avgAutopilotScore** — avg compositeScore of published autopilot posts
- **avgManualScore** — avg compositeScore of published non-autopilot posts
- **scoreDelta** — `autopilotScore - manualScore` (positive = autopilot outperforms)
- **avgAutopilotEngagement** / **avgManualEngagement** — same for engagement rate
- **engagementDelta** — difference in engagement rates

### Breakdowns
- **byChannel** — per-channel: count, publishedCount, avgScore
- **byTrigger** — per-trigger: count, publishedCount, avgScore (new_listing, inactivity_gap, new_review, new_milestone)

### Recent Activity
- Last 10 autopilot drafts with: channel, status, trigger, reason, angle, dates, score

## Range Filtering

Autopilot drafts are filtered by `createdAt` (not `publishedAt`) to include unpublished drafts in volume/rate calculations. Manual drafts for comparison are filtered by `publishedAt` for consistency with other analytics sections.

## Integration

The autopilot analytics service (`autopilotAnalytics.service.js`) is called by `analyticsOverview.service.js` and included in `sections.autopilot`. No new API routes needed.

## Frontend

Section 7 "Autopilot" on the analytics page includes:
- 4 metric cards: Generated, Published (with publish rate), Approval Rate (with rejection count), Avg Score (with delta vs manual)
- Autopilot vs Manual comparison chart (grouped bar chart)
- Trigger breakdown chart (horizontal bar chart)
- Recent activity list (status badges, trigger labels, scores, dates)

## Assumptions
- A draft is "approved" if `approvedBy` is set, or status is APPROVED/SCHEDULED/PUBLISHED
- A draft is "rejected" if `rejectedReason` is set or status is REJECTED
- Approval rate only counts decided drafts (approved + rejected), not pending
- Score comparison only uses PUBLISHED posts to ensure fair comparison
- If data is too sparse for a metric, it returns null rather than a misleading value
