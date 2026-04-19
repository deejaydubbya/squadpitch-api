import { prisma } from '../../prisma.js';

/**
 * Fetch time-series metric snapshots for a post, ordered chronologically.
 */
export async function getPostMetricHistory(draftId, { limit = 50 } = {}) {
  const snapshots = await prisma.postMetricSnapshot.findMany({
    where: { draftId },
    orderBy: { snapshotAt: 'asc' },
    take: limit,
    select: {
      snapshotAt: true,
      impressions: true,
      reach: true,
      engagements: true,
      clicks: true,
      saves: true,
      shares: true,
      comments: true,
      likes: true,
      engagementRate: true,
    },
  });

  return snapshots.map((s) => ({
    ...s,
    snapshotAt: s.snapshotAt.toISOString(),
  }));
}

/**
 * Compute growth deltas between the two most recent snapshots.
 * Returns null if fewer than 2 snapshots exist.
 */
export async function getPostMetricGrowth(draftId) {
  const latest = await prisma.postMetricSnapshot.findMany({
    where: { draftId },
    orderBy: { snapshotAt: 'desc' },
    take: 2,
    select: {
      snapshotAt: true,
      impressions: true,
      reach: true,
      engagements: true,
      clicks: true,
      engagementRate: true,
    },
  });

  if (latest.length < 2) return null;

  const [newer, older] = latest;
  const periodHours = Math.round(
    (newer.snapshotAt.getTime() - older.snapshotAt.getTime()) / (1000 * 60 * 60)
  );

  return {
    impressionsDelta: newer.impressions - older.impressions,
    reachDelta: newer.reach - older.reach,
    engagementsDelta: newer.engagements - older.engagements,
    clicksDelta: newer.clicks - older.clicks,
    engagementRateDelta:
      newer.engagementRate != null && older.engagementRate != null
        ? +(newer.engagementRate - older.engagementRate).toFixed(6)
        : null,
    periodHours,
  };
}
