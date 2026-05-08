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

/**
 * Sync metrics for a single draft.
 *
 * @param {string} draftId
 * @param {object} [options]
 * @param {boolean} [options.force=false] — if true, skip the 1h
 *   `too_recent` cooldown. Used by the internal admin/dev "Sync now"
 *   tool. Normal scheduled sync, post-publish sync, and manual user-
 *   facing sync MUST NOT pass this flag.
 *
 * Result shape (always one of):
 *   { synced: true,  metrics: {...}, rawMetricId, normalizedMetricId }
 *   { synced: false, reason, detail? }
 *
 * Reasons are stable strings — see SOCIAL_METRICS_FEEDBACK_LOOP.md § 3.
 */
export async function syncMetricsForDraft(draftId, { force = false } = {}) {
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

  // Cooldown check. Skipped when force=true so the internal "Sync now"
  // tool can re-run a sync within the hour to debug provider feedback.
  // Public callers (worker, route, post-publish trigger) all leave
  // force at the default false so the production cooldown is preserved.
  if (!force) {
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
  }

  // Get connection with decrypted tokens
  let connection = await getConnectionForAdapter(draft.clientId, draft.channel);
  if (!connection || connection.status !== "CONNECTED") {
    return { synced: false, reason: "no_connection" };
  }

  // Auto-refresh token if near expiry. The error message is captured
  // (without the token) so on-call can distinguish a genuine token-not-
  // refreshable case (refresh token revoked / expired) from a transient
  // upstream Auth0 hiccup.
  try {
    connection = await ensureValidAccessToken(connection);
  } catch (err) {
    return {
      synced: false,
      reason: "token_refresh_failed",
      detail: err?.code ?? err?.message ?? null,
    };
  }

  // Look up the channel's metrics adapter. We treat an unknown channel
  // as a clean "not supported" signal rather than a 500 — keeps the
  // scheduled poll worker from exploding on a row published via a
  // legacy / removed adapter.
  let fetchMetrics;
  try {
    fetchMetrics = getMetricsAdapterForChannel(draft.channel);
  } catch (err) {
    return {
      synced: false,
      reason: "unsupported_channel",
      detail: draft.channel,
    };
  }

  // Fetch raw metrics from platform. Most failure modes are typed by
  // the adapter (AUTH_FAILED, TIKTOK_VIDEO_ID_MISSING, transient flag,
  // status code). We map them onto stable string reasons here so route
  // handlers, the worker, and the Planner UI never see provider-shaped
  // exceptions. Tokens are NEVER included in returned detail strings.
  let result;
  try {
    result = await fetchMetrics({
      connection,
      externalPostId: draft.externalPostId,
    });
  } catch (err) {
    if (err?.code === "TIKTOK_VIDEO_ID_MISSING") {
      return { synced: false, reason: "tiktok_video_id_missing" };
    }
    if (err?.code === "AUTH_FAILED") {
      return { synced: false, reason: "provider_permission_denied" };
    }
    // Transient flag covers 429 + 5xx. Surface "rate_limited" on 429
    // specifically so callers can suggest "try again in a few minutes"
    // vs the more generic "transient" wording.
    if (err?.transient) {
      const status = err?.status ?? 0;
      const reason = status === 429 ? "provider_rate_limited" : "provider_transient";
      return { synced: false, reason, detail: err?.message ?? null };
    }
    // Anything we didn't classify — re-throw so the worker's
    // permanent-error path logs it and moves on.
    throw err;
  }

  if (result === null) {
    return { synced: false, reason: "provider_no_metrics" };
  }

  const { raw, fetchedAt } = result;

  // Store RawMetric (draftId is not @unique, so use findFirst + update/create)
  const existingRaw = await prisma.rawMetric.findFirst({
    where: { draftId },
    orderBy: { fetchedAt: "desc" },
    select: { id: true },
  });

  let rawMetricRow;
  if (existingRaw) {
    rawMetricRow = await prisma.rawMetric.update({
      where: { id: existingRaw.id },
      data: { rawDataJson: raw, fetchedAt },
      select: { id: true },
    });
  } else {
    rawMetricRow = await prisma.rawMetric.create({
      data: {
        draftId,
        clientId: draft.clientId,
        channel: draft.channel,
        rawDataJson: raw,
        fetchedAt,
      },
      select: { id: true },
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

  // Upsert PostMetrics. The flat columns on PostMetrics are intended
  // to be cross-channel comparable, so we coalesce platform-specific
  // names into the common shape:
  //   saves   ← bookmarks (X) / favorites (YT) / saves (IG)
  //   shares  ← retweets (X) / reposts (LinkedIn) / shares (IG/FB/TT)
  //   likes   ← reactions (FB/LinkedIn-legacy) / likes
  // Counts that don't apply to a channel (e.g. saves on YT) fall to 0.
  const metricsData = {
    clientId: draft.clientId,
    channel: draft.channel,
    impressions: normalized.impressions ?? 0,
    reach: normalized.reach ?? 0,
    engagement: normalized.engagements ?? 0,
    clicks: normalized.clicks ?? 0,
    saves: raw.saves ?? raw.bookmarks ?? raw.favorites ?? 0,
    shares: raw.shares ?? raw.reposts ?? raw.retweets ?? 0,
    comments: raw.comments ?? 0,
    likes: raw.likes ?? raw.reactions ?? 0,
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
    // Audit-friendly row ids (used by the internal "Sync now" tool to
    // confirm where the data landed). Safe to expose — no provider
    // payloads or tokens.
    rawMetricId: rawMetricRow?.id ?? null,
    normalizedMetricId: normalizedRow?.id ?? null,
    fetchedAt,
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

// ── TikTok Publish_id → Video_id Resolver Trigger ────────────────────
//
// TikTok's publish init returns a publish_id; the metrics endpoint
// needs the final video_id. After a TikTok publish we enqueue a
// resolve job that polls /v2/post/publish/status/fetch/ until status
// becomes PUBLISH_COMPLETE (or FAILED). On success the worker rewrites
// Draft.externalPostId so the regular metrics sync path "just works".
//
// First poll runs after a 30s delay (typical TikTok upload turnaround
// is 30–60s). The worker re-enqueues with backoff on still_processing.

export function enqueueTiktokVideoIdResolution(draftId, { delayMs = 30_000, attempt = 1 } = {}) {
  const queue = getMetricsSyncQueue();
  if (!queue) return;
  queue
    .add(
      "resolve-tiktok-video-id",
      { draftId, attempt },
      // jobId includes the attempt so successive enqueues don't collide.
      { delay: delayMs, jobId: `resolve-tiktok-${draftId}-${attempt}` }
    )
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
