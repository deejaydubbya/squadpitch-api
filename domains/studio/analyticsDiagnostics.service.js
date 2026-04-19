import { prisma } from '../../prisma.js';
import { formatConnection } from './connection.service.js';

export async function getAnalyticsDiagnostics(clientId) {
  // Per-channel coverage
  const drafts = await prisma.draft.findMany({
    where: { clientId, status: 'PUBLISHED' },
    select: {
      id: true,
      channel: true,
      publishedAt: true,
      normalizedMetric: { select: { id: true } },
      postInsight: { select: { id: true } },
      metrics: { select: { lastSyncedAt: true } },
    },
  });

  // Channel coverage breakdown
  const channelGroups = {};
  for (const d of drafts) {
    if (!channelGroups[d.channel]) {
      channelGroups[d.channel] = { published: 0, synced: 0, internalOnly: 0, lastSyncedAt: null };
    }
    channelGroups[d.channel].published++;
    if (d.normalizedMetric) {
      channelGroups[d.channel].synced++;
      const syncAt = d.metrics?.lastSyncedAt;
      if (syncAt && (!channelGroups[d.channel].lastSyncedAt || syncAt > channelGroups[d.channel].lastSyncedAt)) {
        channelGroups[d.channel].lastSyncedAt = syncAt;
      }
    } else if (d.postInsight) {
      channelGroups[d.channel].internalOnly++;
    }
  }

  const channelCoverage = Object.entries(channelGroups)
    .map(([channel, data]) => ({
      channel,
      published: data.published,
      synced: data.synced,
      internalOnly: data.internalOnly,
      coveragePercent: data.published > 0 ? Math.round((data.synced / data.published) * 100) : 0,
      lastSyncedAt: data.lastSyncedAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.published - a.published);

  // Connection health
  const connections = await prisma.channelConnection.findMany({
    where: { clientId },
    select: {
      id: true,
      channel: true,
      status: true,
      displayName: true,
      tokenExpiresAt: true,
      lastValidatedAt: true,
      lastError: true,
      updatedAt: true,
    },
  });

  const connectionHealth = connections.map((c) => ({
    channel: c.channel,
    status: c.status,
    displayName: c.displayName,
    tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
    lastValidatedAt: c.lastValidatedAt?.toISOString() ?? null,
    lastError: c.status !== 'CONNECTED' ? c.lastError : null,
    isHealthy: c.status === 'CONNECTED',
  }));

  // Freshness warnings
  const freshnessWarnings = [];
  const now = Date.now();

  // Warn about stale syncs (posts published 24h+ ago with no sync)
  const stalePosts = drafts.filter((d) => {
    if (d.normalizedMetric) return false;
    if (!d.publishedAt) return false;
    return (now - new Date(d.publishedAt).getTime()) > 86400000; // 24h
  });
  if (stalePosts.length > 0) {
    freshnessWarnings.push({
      type: 'stale_sync',
      message: `${stalePosts.length} post${stalePosts.length === 1 ? '' : 's'} published 24h+ ago without platform metrics`,
      severity: stalePosts.length > 5 ? 'warning' : 'info',
      count: stalePosts.length,
    });
  }

  // Warn about expired/broken connections
  const brokenConnections = connections.filter((c) => c.status !== 'CONNECTED');
  if (brokenConnections.length > 0) {
    freshnessWarnings.push({
      type: 'connection_issue',
      message: `${brokenConnections.length} connection${brokenConnections.length === 1 ? '' : 's'} need${brokenConnections.length === 1 ? 's' : ''} attention: ${brokenConnections.map((c) => c.channel).join(', ')}`,
      severity: 'warning',
      count: brokenConnections.length,
    });
  }

  // Warn about channels with no connection
  const connectedChannels = new Set(connections.map((c) => c.channel));
  const publishedChannels = new Set(drafts.map((d) => d.channel));
  const unconnectedChannels = [...publishedChannels].filter((ch) => !connectedChannels.has(ch));
  if (unconnectedChannels.length > 0) {
    freshnessWarnings.push({
      type: 'no_connection',
      message: `No connection for ${unconnectedChannels.join(', ')} — metrics cannot be synced`,
      severity: 'info',
      count: unconnectedChannels.length,
    });
  }

  // Overall health
  const totalPublished = drafts.length;
  const totalSynced = drafts.filter((d) => d.normalizedMetric).length;
  const coverageRatio = totalPublished > 0 ? totalSynced / totalPublished : 0;
  const hasConnectionIssues = brokenConnections.length > 0;

  let overallHealth = 'healthy';
  if (coverageRatio === 0 && totalPublished > 0) {
    overallHealth = 'unhealthy';
  } else if (coverageRatio < 0.5 || hasConnectionIssues) {
    overallHealth = 'degraded';
  }

  return {
    channelCoverage,
    connectionHealth,
    freshnessWarnings,
    overallHealth,
  };
}
