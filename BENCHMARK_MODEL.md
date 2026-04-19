# Benchmark Model

## Overview

The benchmark system provides workspace-local performance baselines so analytics can compare results against meaningful context rather than showing only raw absolute values. It answers: "Is this post performing above or below my typical results?"

## Benchmark Hierarchy

| Level | What It Measures | Example |
|-------|-----------------|---------|
| **1. Workspace** | Overall averages across all published posts | "Your average score is 62" |
| **2. Channel** | Averages per platform | "Your LinkedIn posts average 71, Instagram averages 58" |
| **3. Content Type** | Averages per content type | "Your educational posts average 68, promotional posts average 54" |
| **4. Media Type** | Averages per media format | "Your video posts average 74, image posts average 61" |
| **Future: Industry** | Comparison against similar businesses | Not yet implemented — requires cross-workspace aggregation |
| **Future: Niche** | Platform-specific niche benchmarks | Not yet implemented — requires external data |

Each benchmark level computes: `avgScore`, `avgEngagementRate`, `avgReach`, `sampleSize`, and `confidence`.

## Confidence Levels

| Confidence | Sample Size | Display Behavior |
|------------|-------------|-----------------|
| **high** | 10+ posts | Show comparison freely |
| **medium** | 5-9 posts | Show comparison, no special note |
| **low** | 3-4 posts | Show comparison with "(limited data)" note |
| **insufficient** | <3 posts | Do not show comparison |

When sample size is insufficient, the benchmark is returned as null in comparisons. The frontend hides comparison indicators for insufficient data rather than showing misleading baselines.

## How Comparisons Work

The `compareToBenchmark(value, benchmark, metric)` function:
1. Returns `null` if value is null, benchmark is null, or confidence is insufficient
2. Computes `delta = value - benchmarkValue`
3. For scores: delta in points (e.g., "+5.2 pts above")
4. For engagement rates: delta in percentage points (e.g., "+0.15 pp above")
5. Returns: `{ delta, benchmarkValue, label: 'above'|'below'|'at', confidence, sampleSize, unit }`

The `describeBenchmarkComparison()` helper generates plain-language descriptions:
- "5.2 points above your typical LinkedIn score"
- "At your typical video engagement rate (limited data)"
- "3.1 points below your typical educational content score"

## Where Benchmarks Are Exposed

### Analytics Overview
`sections.benchmarks` contains the full benchmark dataset:
- Workspace-wide averages
- Per-channel averages
- Per-content-type averages
- Per-media-type averages

Displayed in Section 9 "Benchmarks" with confidence badges.

### Post Detail
`benchmarkComparison` on each post detail response:
- `vsWorkspace` — score and engagement vs workspace average
- `vsChannel` — score and engagement vs same-channel average
- `vsContentType` — score and engagement vs same-content-type average (if available)

Shown as "+X pts above/below" indicators in the post detail modal.

## Data Source

Benchmarks are computed from the same data already used by analytics:
- `PostInsight.compositeScore` for quality/performance scores
- `NormalizedMetric.engagementRate` for platform engagement
- `NormalizedMetric.reach` for distribution reach

Range filtering applies (7d/30d/90d/all) so benchmarks reflect the selected time period.

## Design Principles

1. **Workspace-local only** — No global datasets, no cross-workspace comparison. Your baseline is your own performance.
2. **Transparent** — Every comparison shows the baseline value, delta, and confidence level. No opaque formulas.
3. **Graceful degradation** — Low sample sizes are handled explicitly rather than hidden. Insufficient data shows no comparison rather than a misleading one.
4. **Extensible** — The `BenchmarkValue` interface and `compareToBenchmark` helper are designed for future industry/niche benchmarks. When external data sources are added, they slot into the same comparison framework.
