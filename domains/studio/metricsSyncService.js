// Metrics sync orchestrator.
//
// Pipeline: load draft → check cooldown → get connection → refresh token →
// fetch raw → store RawMetric → normalize → store NormalizedMetric →
// compute score → update PostInsight → upsert PostMetrics →
// append PostMetricSnapshot → fire-and-forget performance updates.

import { prisma } from "../../prisma.js";
import { getConnectionForAdapter } from "./connection.service.js";
import { ensureValidAccessToken } from "./tokenRefreshService.js";
import { getMetricsAdapterForChannel } from "./metricsSync/index.js";
import { normalizeRawMetrics, computeAndSaveInsight } from "./normalization.service.js";
import {
  computePerformanceScore,
  getClientChannelBenchmarks,
  getPostingConsistencyScore,
} from "./performanceScoring.service.js";
import { getMetricsSyncQueue } from "../../lib/queues.js";
import { getClientTimezone } from "../../lib/timezone.js";

const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ── Main Sync Pipeline ───────────────────────────────────────────────

export async function syncMetricsForDraft(draftId) {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      clientId: true,
      channel: true,
      body: true,
      hooks: true,
      hashtags: true,
      cta: true,
      mediaUrl: true,
      mediaType: true,
      publishedAt: true,
      externalPostId: true,
      status: true,
    },
  });

  if (!draft) return { synced: false, reason: "draft_not_found" };
  if (draft.status !== "PUBLISHED") return { synced: false, reason: "not_published" };
  if (!draft.externalPostId) return { synced: false, reason: "no_external_id" };

  // Cooldown check
  const existing = await prisma.postMetrics.findUnique({
    where: { draftId },
    select: { lastSyncedAt: true },
  });
  if (existing?.lastSyncedAt) {
    const elapsed = Date.now() - new Date(existing.lastSyncedAt).getTime();
    if (elapsed < MIN_SYNC_INTERVAL_MS) {
      return { synced: false, reason: "too_recent" };
    }
  }

  // Get connection with decrypted tokens
  let connection = await getConnectionForAdapter(draft.clientId, draft.channel);
  if (!connection || connection.status !== "CONNECTED") {
    return { synced: false, reason: "no_connection" };
  }

  // Auto-refresh token if near expiry
  try {
    connection = await ensureValidAccessToken(connection);
  } catch {
    return { synced: false, reason: "token_refresh_failed" };
  }

  // Fetch raw metrics from platform
  const fetchMetrics = getMetricsAdapterForChannel(draft.channel);
  const result = await fetchMetrics({
    connection,
    externalPostId: draft.externalPostId,
  });

  if (result === null) {
    return { synced: false, reason: "post_not_found" };
  }

  const { raw, fetchedAt } = result;

  // Store RawMetric (draftId is not @unique, so use findFirst + update/create)
  const existingRaw = await prisma.rawMetric.findFirst({
    where: { draftId },
    orderBy: { fetchedAt: "desc" },
    select: { id: true },
  });

  if (existingRaw) {
    await prisma.rawMetric.update({
      where: { id: existingRaw.id },
      data: { rawDataJson: raw, fetchedAt },
    });
  } else {
    await prisma.rawMetric.create({
      data: {
        draftId,
        clientId: draft.clientId,
        channel: draft.channel,
        rawDataJson: raw,
        fetchedAt,
      },
    });
  }

  // Normalize
  const normalized = normalizeRawMetrics(draft.channel, raw);

  // Store NormalizedMetric
  const normalizedRow = await prisma.normalizedMetric.upsert({
    where: { draftId },
    create: {
      draftId,
      clientId: draft.clientId,
      channel: draft.channel,
      ...normalized,
    },
    update: normalized,
  });

  // Compute performance score
  const benchmarks = await getClientChannelBenchmarks(draft.clientId, draft.channel);
  const consistencyScore = await getPostingConsistencyScore(draft.clientId);
  const { qualityScore, observedScore, compositeScore } = computePerformanceScore(draft, normalizedRow, benchmarks, consistencyScore);

  // Update PostInsight with new scores
  const timezone = await getClientTimezone(draft.clientId);
  await computeAndSaveInsight(draft, { ...normalizedRow, relativeEngagementRate: null }, { timezone });
  // Override with weighted scores if engagement data available
  if (normalized.engagementRate != null) {
    await prisma.postInsight.update({
      where: { draftId },
      data: { qualityScore, observedScore, compositeScore },
    });
  }

  // Upsert PostMetrics
  const metricsData = {
    clientId: draft.clientId,
    channel: draft.channel,
    impressions: normalized.impressions ?? 0,
    reach: normalized.reach ?? 0,
    engagement: normalized.engagements ?? 0,
    clicks: normalized.clicks ?? 0,
    saves: raw.saves ?? 0,
    shares: raw.shares ?? raw.retweets ?? 0,
    comments: raw.comments ?? 0,
    likes: raw.likes ?? 0,
    engagementRate: normalized.engagementRate ?? 0,
    lastSyncedAt: fetchedAt,
  };

  await prisma.postMetrics.upsert({
    where: { draftId },
    create: { draftId, ...metricsData },
    update: metricsData,
  });

  // Append time-series snapshot (deduped by draftId + snapshotAt)
  const snapshotFields = {
    impressions: metricsData.impressions,
    reach: metricsData.reach,
    engagements: metricsData.engagement,
    clicks: metricsData.clicks,
    saves: metricsData.saves,
    shares: metricsData.shares,
    comments: metricsData.comments,
    likes: metricsData.likes,
    engagementRate: metricsData.engagementRate,
  };
  await prisma.postMetricSnapshot.upsert({
    where: { draftId_snapshotAt: { draftId, snapshotAt: fetchedAt } },
    create: { draftId, clientId: draft.clientId, channel: draft.channel, snapshotAt: fetchedAt, ...snapshotFields },
    update: snapshotFields,
  });

  // Recalculate data item + blueprint performance with fresh metrics
  import("./dataAnalytics.service.js")
    .then(({ updatePerformanceForDraft }) =>
      updatePerformanceForDraft(draftId)
    )
    .catch(() => {});

  return {
    synced: true,
    metrics: {
      ...metricsData,
      qualityScore,
      observedScore,
      compositeScore,
    },
  };
}

// ── Eligible Drafts Query ────────────────────────────────────────────

export async function getEligibleDraftsForSync({ batchSize = 20 } = {}) {
  const cooldownThreshold = new Date(Date.now() - MIN_SYNC_INTERVAL_MS);

  return prisma.draft.findMany({
    where: {
      status: "PUBLISHED",
      externalPostId: { not: null },
      client: {
        status: "ACTIVE",
        connections: {
          some: { status: "CONNECTED" },
        },
      },
      OR: [
        { metrics: null },
        { metrics: { lastSyncedAt: null } },
        { metrics: { lastSyncedAt: { lt: cooldownThreshold } } },
      ],
    },
    select: { id: true, channel: true, clientId: true },
    orderBy: [
      // Never-synced first, then oldest lastSyncedAt
      { metrics: { lastSyncedAt: "asc" } },
    ],
    take: batchSize,
  });
}

// ── Post-Publish Sync Trigger ────────────────────────────────────────

export function enqueuePostPublishSync(draftId, delayMs = 300_000) {
  const queue = getMetricsSyncQueue();
  if (!queue) return;
  queue
    .add("sync-single", { draftId }, { delay: delayMs, jobId: `sync-${draftId}` })
    .catch(() => {});
}

// ── Sync Status ──────────────────────────────────────────────────────

export async function getMetricsSyncStatus(clientId) {
  const totalPublished = await prisma.draft.count({
    where: { clientId, status: "PUBLISHED", externalPostId: { not: null } },
  });

  const synced = await prisma.postMetrics.findMany({
    where: { clientId, lastSyncedAt: { not: null } },
    select: { lastSyncedAt: true },
    orderBy: { lastSyncedAt: "desc" },
  });

  const syncedPostCount = synced.length;
  const lastSyncedAt = synced[0]?.lastSyncedAt ?? null;

  const cooldownThreshold = new Date(Date.now() - MIN_SYNC_INTERVAL_MS);
  const pendingSyncCount = await prisma.draft.count({
    where: {
      clientId,
      status: "PUBLISHED",
      externalPostId: { not: null },
      OR: [
        { metrics: null },
        { metrics: { lastSyncedAt: null } },
        { metrics: { lastSyncedAt: { lt: cooldownThreshold } } },
      ],
    },
  });

  return { lastSyncedAt, syncedPostCount, pendingSyncCount, totalPublished };
}
