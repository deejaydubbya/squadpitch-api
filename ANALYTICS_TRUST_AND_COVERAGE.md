# Analytics Trust & Coverage

## Overview

The trust/coverage diagnostics layer helps users understand how complete and reliable their analytics are. Rather than showing raw internal errors, it surfaces clean, confidence-building information about data completeness, sync status, and connection health.

## What a User Can Now Understand

### 1. Overall Coverage
- **How many posts have real platform metrics** vs AI-only scoring
- **Coverage percentage** displayed as a progress bar
- **Overall health** indicator: Healthy / Degraded / Unhealthy

### 2. Per-Channel Coverage
- **Sync coverage per platform** — e.g., "Instagram: 15/18 synced (83%)"
- **Last sync timestamp per channel** — e.g., "Last synced 2h ago"
- Visual progress bars per channel

### 3. Connection Health
- **Status per connection** — Connected (green), Expired (red), Needs Reconnect (yellow), Error (red)
- **Account display name** for identification
- Clean indicators that show what needs attention without exposing internal errors

### 4. Freshness Warnings
- **Stale sync warnings** — posts published 24h+ ago without platform metrics
- **Connection issues** — channels that need reconnection
- **Missing connections** — channels you publish to but haven't connected for metrics
- Severity levels: `info` (informational) vs `warning` (action needed)

## Coverage States

| State | Meaning | User Message |
|-------|---------|-------------|
| **Full** | All published posts have platform engagement data | (no message needed — everything is working) |
| **Partial** | Some posts synced, rest use AI assessment | "Engagement data available for X% of posts. Remaining posts use AI quality assessment." |
| **Internal Only** | No platform metrics synced yet | "Analytics are based on AI quality assessment. Engagement data will appear once channels are synced." |

## Overall Health Calculation

| Health | Condition |
|--------|-----------|
| **Healthy** | Coverage ratio >= 50% AND no broken connections |
| **Degraded** | Coverage ratio < 50% OR has broken connections |
| **Unhealthy** | Coverage ratio = 0% with published posts (no metrics at all) |

## Diagnostics Data Source

The `analyticsDiagnostics.service.js` queries:
- `Draft` model for per-channel published/synced counts
- `ChannelConnection` model for connection health signals
- Cross-references published channels against connected channels

All diagnostic data is merged into the existing `coverage` section of the analytics overview response. No new API routes needed.

## Architecture

```
analyticsOverview.service.js
  └─ getAnalyticsDiagnostics(clientId)
       ├─ Per-channel coverage (published vs synced counts)
       ├─ Connection health (status, display name, last validated)
       ├─ Freshness warnings (stale syncs, broken connections, missing connections)
       └─ Overall health assessment

Frontend: CoverageMeter component (enhanced)
  ├─ Overall coverage bar + percentage
  ├─ Per-channel coverage bars
  ├─ Connection health indicators (colored dots + status labels)
  └─ Freshness warning notices (clean, non-alarming messaging)
```

## Design Principles

1. **Confidence, not alarmism** — messages are informational and action-oriented, not scary
2. **Clean user-facing messaging** — no raw error strings, no technical jargon
3. **Progressive disclosure** — overall health at a glance, drill into per-channel details below
4. **Severity levels** — `info` for things to be aware of, `warning` only when action is needed
5. **No internal errors exposed** — connection `lastError` is only shown for non-CONNECTED connections, and only the stored message (not stack traces)
