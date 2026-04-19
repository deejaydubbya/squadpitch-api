import { prisma } from '../../prisma.js';

// ── Confidence ────────────────────────────────────────────────────────

function getConfidence(sampleSize) {
  if (sampleSize >= 10) return 'high';
  if (sampleSize >= 5) return 'medium';
  if (sampleSize >= 3) return 'low';
  return 'insufficient';
}

// ── Benchmark computation ─────────────────────────────────────────────

function computeBenchmark(drafts) {
  const scores = drafts.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
  const engRates = drafts.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);
  const reaches = drafts.map((d) => d.normalizedMetric?.reach).filter((r) => r != null);

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    avgScore: scores.length > 0 ? Math.round(avg(scores) * 10) / 10 : null,
    avgEngagementRate: engRates.length > 0 ? avg(engRates) : null,
    avgReach: reaches.length > 0 ? Math.round(avg(reaches)) : null,
    sampleSize: drafts.length,
    scoreSampleSize: scores.length,
    engagementSampleSize: engRates.length,
    confidence: getConfidence(drafts.length),
  };
}

// ── Main export ───────────────────────────────────────────────────────

export async function getWorkspaceBenchmarks(clientId, { since } = {}) {
  const dateFilter = since ? { publishedAt: { gte: since } } : {};

  const drafts = await prisma.draft.findMany({
    where: { clientId, status: 'PUBLISHED', ...dateFilter },
    select: {
      channel: true,
      normalizedMetric: {
        select: { engagementRate: true, reach: true, impressions: true },
      },
      postInsight: {
        select: { compositeScore: true, contentType: true, mediaType: true },
      },
    },
  });

  if (drafts.length === 0) {
    return {
      workspace: { avgScore: null, avgEngagementRate: null, avgReach: null, sampleSize: 0, scoreSampleSize: 0, engagementSampleSize: 0, confidence: 'insufficient' },
      byChannel: {},
      byContentType: {},
      byMediaType: {},
      hasData: false,
    };
  }

  // Workspace-wide
  const workspace = computeBenchmark(drafts);

  // By channel
  const channelGroups = {};
  for (const d of drafts) {
    if (!channelGroups[d.channel]) channelGroups[d.channel] = [];
    channelGroups[d.channel].push(d);
  }
  const byChannel = {};
  for (const [channel, items] of Object.entries(channelGroups)) {
    byChannel[channel] = computeBenchmark(items);
  }

  // By content type
  const contentTypeGroups = {};
  for (const d of drafts) {
    const ct = d.postInsight?.contentType;
    if (!ct) continue;
    if (!contentTypeGroups[ct]) contentTypeGroups[ct] = [];
    contentTypeGroups[ct].push(d);
  }
  const byContentType = {};
  for (const [ct, items] of Object.entries(contentTypeGroups)) {
    byContentType[ct] = computeBenchmark(items);
  }

  // By media type
  const mediaTypeGroups = {};
  for (const d of drafts) {
    const mt = d.postInsight?.mediaType;
    if (!mt) continue;
    if (!mediaTypeGroups[mt]) mediaTypeGroups[mt] = [];
    mediaTypeGroups[mt].push(d);
  }
  const byMediaType = {};
  for (const [mt, items] of Object.entries(mediaTypeGroups)) {
    byMediaType[mt] = computeBenchmark(items);
  }

  return {
    workspace,
    byChannel,
    byContentType,
    byMediaType,
    hasData: true,
  };
}

// ── Comparison helper ─────────────────────────────────────────────────

export function compareToBenchmark(value, benchmark, metric = 'avgScore') {
  if (value == null || !benchmark || benchmark[metric] == null) return null;
  if (benchmark.confidence === 'insufficient') return null;

  const benchmarkValue = benchmark[metric];
  const delta = value - benchmarkValue;

  // For rates, express as percentage points; for scores, express as points
  const isRate = metric === 'avgEngagementRate';
  const roundedDelta = isRate
    ? Math.round(delta * 10000) / 100   // to percentage points (2 decimals)
    : Math.round(delta * 10) / 10;

  const absDelta = Math.abs(roundedDelta);
  let label;
  if (isRate) {
    label = absDelta < 0.01 ? 'at' : delta > 0 ? 'above' : 'below';
  } else {
    label = absDelta < 0.5 ? 'at' : delta > 0 ? 'above' : 'below';
  }

  return {
    delta: roundedDelta,
    benchmarkValue: isRate ? Math.round(benchmarkValue * 10000) / 100 : Math.round(benchmarkValue * 10) / 10,
    label,
    confidence: benchmark.confidence,
    sampleSize: benchmark.sampleSize,
    unit: isRate ? 'pp' : 'pts',
  };
}

// ── Describe comparison in plain language ──────────────────────────────

export function describeBenchmarkComparison(value, benchmark, metric = 'avgScore', context = '') {
  const cmp = compareToBenchmark(value, benchmark, metric);
  if (!cmp) return null;

  const metricLabel = metric === 'avgEngagementRate' ? 'engagement rate' : 'score';
  const confidenceNote = cmp.confidence === 'low' ? ' (limited data)' : '';

  if (cmp.label === 'at') {
    return `At your typical ${context} ${metricLabel}${confidenceNote}`;
  }

  const direction = cmp.label === 'above' ? 'above' : 'below';
  const amount = Math.abs(cmp.delta);
  const unitLabel = cmp.unit === 'pp' ? 'pp' : `point${amount !== 1 ? 's' : ''}`;

  return `${amount} ${unitLabel} ${direction} your typical ${context} ${metricLabel}${confidenceNote}`;
}
