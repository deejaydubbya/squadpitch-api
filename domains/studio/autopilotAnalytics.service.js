import { prisma } from '../../prisma.js';

// ── Warning parser ────────────────────────────────────────────────────

function parseAutopilotMeta(warnings) {
  const meta = {};
  for (const w of warnings || []) {
    if (w.startsWith('autopilot_trigger: ')) meta.trigger = w.slice('autopilot_trigger: '.length);
    if (w.startsWith('autopilot_reason: ')) meta.reason = w.slice('autopilot_reason: '.length);
    if (w.startsWith('autopilot_mode: ')) meta.mode = w.slice('autopilot_mode: '.length);
    if (w.startsWith('autopilot_asset: ')) meta.asset = w.slice('autopilot_asset: '.length);
    if (w.startsWith('autopilot_angle_label: ')) meta.angle = w.slice('autopilot_angle_label: '.length);
  }
  return meta;
}

// ── Main ──────────────────────────────────────────────────────────────

export async function getAutopilotSection({ clientId, since }) {
  const dateFilter = since ? { createdAt: { gte: since } } : {};
  const publishedDateFilter = since ? { publishedAt: { gte: since } } : {};

  // Autopilot drafts (by createdAt to capture unpublished too)
  const autopilotDrafts = await prisma.draft.findMany({
    where: {
      clientId,
      OR: [
        { warnings: { has: 'autopilot: true' } },
        { createdBy: 'system:autopilot' },
        { createdBy: 'system:auto_generate' },
      ],
      ...dateFilter,
    },
    select: {
      id: true,
      status: true,
      channel: true,
      body: true,
      warnings: true,
      createdBy: true,
      approvedBy: true,
      approvedAt: true,
      rejectedReason: true,
      publishedAt: true,
      createdAt: true,
      normalizedMetric: {
        select: { impressions: true, reach: true, engagements: true, engagementRate: true },
      },
      postInsight: {
        select: { qualityScore: true, observedScore: true, compositeScore: true, contentType: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (autopilotDrafts.length === 0) {
    return {
      totalGenerated: 0,
      totalPublished: 0,
      totalApproved: 0,
      totalRejected: 0,
      totalPending: 0,
      approvalRate: null,
      publishRate: null,
      avgAutopilotScore: null,
      avgManualScore: null,
      scoreDelta: null,
      avgAutopilotEngagement: null,
      avgManualEngagement: null,
      engagementDelta: null,
      byChannel: [],
      byTrigger: [],
      recentActivity: [],
      hasData: false,
    };
  }

  // Counts by status
  const totalGenerated = autopilotDrafts.length;
  const totalPublished = autopilotDrafts.filter((d) => d.status === 'PUBLISHED').length;
  const totalApproved = autopilotDrafts.filter(
    (d) => d.approvedBy != null || d.status === 'APPROVED' || d.status === 'SCHEDULED' || d.status === 'PUBLISHED',
  ).length;
  const totalRejected = autopilotDrafts.filter(
    (d) => d.rejectedReason != null || d.status === 'REJECTED',
  ).length;
  const totalPending = autopilotDrafts.filter(
    (d) => d.status === 'DRAFT' || d.status === 'PENDING_REVIEW',
  ).length;

  const decidedCount = totalApproved + totalRejected;
  const approvalRate = decidedCount > 0 ? totalApproved / decidedCount : null;
  const publishRate = totalGenerated > 0 ? totalPublished / totalGenerated : null;

  // Autopilot published scores
  const publishedAutopilot = autopilotDrafts.filter((d) => d.status === 'PUBLISHED');
  const apScores = publishedAutopilot.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
  const apEngRates = publishedAutopilot.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);

  const avgAutopilotScore = apScores.length > 0
    ? Math.round((apScores.reduce((a, b) => a + b, 0) / apScores.length) * 10) / 10
    : null;
  const avgAutopilotEngagement = apEngRates.length > 0
    ? apEngRates.reduce((a, b) => a + b, 0) / apEngRates.length
    : null;

  // Manual published drafts for comparison
  const manualPublished = await prisma.draft.findMany({
    where: {
      clientId,
      status: 'PUBLISHED',
      NOT: {
        OR: [
          { warnings: { has: 'autopilot: true' } },
          { createdBy: 'system:autopilot' },
          { createdBy: 'system:auto_generate' },
        ],
      },
      ...publishedDateFilter,
    },
    select: {
      normalizedMetric: {
        select: { engagementRate: true },
      },
      postInsight: {
        select: { compositeScore: true },
      },
    },
  });

  const manualScores = manualPublished.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
  const manualEngRates = manualPublished.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);

  const avgManualScore = manualScores.length > 0
    ? Math.round((manualScores.reduce((a, b) => a + b, 0) / manualScores.length) * 10) / 10
    : null;
  const avgManualEngagement = manualEngRates.length > 0
    ? manualEngRates.reduce((a, b) => a + b, 0) / manualEngRates.length
    : null;

  const scoreDelta = avgAutopilotScore != null && avgManualScore != null
    ? Math.round((avgAutopilotScore - avgManualScore) * 10) / 10
    : null;
  const engagementDelta = avgAutopilotEngagement != null && avgManualEngagement != null
    ? avgAutopilotEngagement - avgManualEngagement
    : null;

  // By channel
  const channelGroups = {};
  for (const d of autopilotDrafts) {
    const ch = d.channel;
    if (!channelGroups[ch]) channelGroups[ch] = { total: 0, published: 0, scores: [] };
    channelGroups[ch].total++;
    if (d.status === 'PUBLISHED') {
      channelGroups[ch].published++;
      if (d.postInsight?.compositeScore != null) channelGroups[ch].scores.push(d.postInsight.compositeScore);
    }
  }

  const byChannel = Object.entries(channelGroups).map(([channel, data]) => ({
    channel,
    count: data.total,
    publishedCount: data.published,
    avgScore: data.scores.length > 0
      ? Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10
      : null,
  }));

  // By trigger
  const triggerGroups = {};
  for (const d of autopilotDrafts) {
    const meta = parseAutopilotMeta(d.warnings);
    const trigger = meta.trigger || 'unknown';
    if (!triggerGroups[trigger]) triggerGroups[trigger] = { total: 0, published: 0, scores: [] };
    triggerGroups[trigger].total++;
    if (d.status === 'PUBLISHED') {
      triggerGroups[trigger].published++;
      if (d.postInsight?.compositeScore != null) triggerGroups[trigger].scores.push(d.postInsight.compositeScore);
    }
  }

  const byTrigger = Object.entries(triggerGroups).map(([trigger, data]) => ({
    trigger,
    count: data.total,
    publishedCount: data.published,
    avgScore: data.scores.length > 0
      ? Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10
      : null,
  }));

  // Recent activity (last 10)
  const recentActivity = autopilotDrafts.slice(0, 10).map((d) => {
    const meta = parseAutopilotMeta(d.warnings);
    return {
      id: d.id,
      channel: d.channel,
      status: d.status,
      body: d.body?.slice(0, 120) || '',
      trigger: meta.trigger || null,
      reason: meta.reason || null,
      angle: meta.angle || null,
      createdAt: d.createdAt?.toISOString() || null,
      publishedAt: d.publishedAt?.toISOString() || null,
      score: d.postInsight?.compositeScore ?? null,
    };
  });

  return {
    totalGenerated,
    totalPublished,
    totalApproved,
    totalRejected,
    totalPending,
    approvalRate,
    publishRate,
    avgAutopilotScore,
    avgManualScore,
    scoreDelta,
    avgAutopilotEngagement,
    avgManualEngagement,
    engagementDelta,
    byChannel,
    byTrigger,
    recentActivity,
    hasData: true,
  };
}
