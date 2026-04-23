import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";

const startedAt = Date.now();

// ── Health & Auth ────────────────────────────────────────────────────────

export function getHealth() {
  return {
    status: "ok",
    environment: env.NODE_ENV || "development",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: env.APP_VERSION || "dev",
  };
}

export function getUserWithRoles(user, roles) {
  return { id: user.id, email: user.email, name: user.name, roles };
}

// ── Workspace Inspector ──────────────────────────────────────────────────

export async function listWorkspaces({ search, status, limit = 50, cursor }) {
  const where = {};

  if (status) where.status = status;

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { id: { equals: search } },
      { createdBy: { contains: search, mode: "insensitive" } },
    ];
  }

  const clients = await prisma.client.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      connections: {
        select: { channel: true, status: true },
      },
      _count: {
        select: { drafts: true },
      },
    },
  });

  const hasMore = clients.length > limit;
  const items = hasMore ? clients.slice(0, limit) : clients;

  // Batch-fetch owner users
  const ownerSubs = [...new Set(items.map((c) => c.createdBy))];
  const owners = await prisma.user.findMany({
    where: { auth0Sub: { in: ownerSubs } },
    select: { auth0Sub: true, email: true, name: true },
  });
  const ownerMap = Object.fromEntries(owners.map((u) => [u.auth0Sub, u]));

  // Batch-fetch subscriptions
  const ownerIds = owners.map((u) => u.auth0Sub);
  const userRecords = await prisma.user.findMany({
    where: { auth0Sub: { in: ownerIds } },
    select: { id: true, auth0Sub: true },
  });
  const userIdMap = Object.fromEntries(userRecords.map((u) => [u.auth0Sub, u.id]));
  const subscriptions = await prisma.subscription.findMany({
    where: { userId: { in: Object.values(userIdMap) } },
    select: { userId: true, tier: true, status: true },
  });
  const subMap = Object.fromEntries(subscriptions.map((s) => [s.userId, s]));

  return {
    items: items.map((c) => {
      const owner = ownerMap[c.createdBy] || null;
      const sub = owner ? subMap[userIdMap[c.createdBy]] || null : null;
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        status: c.status,
        industryKey: c.industryKey,
        logoUrl: c.logoUrl,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        owner: owner ? { email: owner.email, name: owner.name } : null,
        tier: sub?.tier || null,
        subscriptionStatus: sub?.status || null,
        draftCount: c._count.drafts,
        channels: c.connections.map((cc) => ({
          channel: cc.channel,
          status: cc.status,
        })),
      };
    }),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

export async function getWorkspaceDetail(clientId) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      brandProfile: true,
      voiceProfile: { select: { tone: true, version: true, updatedAt: true } },
      mediaProfile: { select: { mode: true, visualStyle: true, updatedAt: true } },
      channelSettings: true,
      connections: true,
      techStackConnections: true,
      workspaceAnalytics: true,
    },
  });

  if (!client) return null;

  // Owner info
  const owner = await prisma.user.findUnique({
    where: { auth0Sub: client.createdBy },
    select: { id: true, auth0Sub: true, email: true, name: true, createdAt: true },
  });

  // Subscription
  let subscription = null;
  if (owner) {
    subscription = await prisma.subscription.findUnique({
      where: { userId: owner.id },
      select: { tier: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
    });
  }

  // Recent drafts (last 20)
  const recentDrafts = await prisma.draft.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      kind: true,
      status: true,
      channel: true,
      body: true,
      campaignName: true,
      publishError: true,
      publishAttempts: true,
      warnings: true,
      modelUsed: true,
      createdAt: true,
      scheduledFor: true,
      publishedAt: true,
    },
  });

  // Recent failures
  const recentFailures = await prisma.draft.findMany({
    where: { clientId, status: "FAILED" },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: {
      id: true,
      channel: true,
      publishError: true,
      publishAttempts: true,
      lastPublishAttemptAt: true,
      updatedAt: true,
    },
  });

  return {
    id: client.id,
    name: client.name,
    slug: client.slug,
    status: client.status,
    industryKey: client.industryKey,
    timezone: client.timezone,
    logoUrl: client.logoUrl,
    createdBy: client.createdBy,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    owner: owner
      ? { id: owner.id, auth0Sub: owner.auth0Sub, email: owner.email, name: owner.name, createdAt: owner.createdAt }
      : null,
    subscription,
    brand: client.brandProfile
      ? {
          description: client.brandProfile.description,
          industry: client.brandProfile.industry,
          website: client.brandProfile.website,
          city: client.brandProfile.city,
          state: client.brandProfile.state,
        }
      : null,
    voice: client.voiceProfile,
    media: client.mediaProfile,
    channelSettings: client.channelSettings.map((cs) => ({
      channel: cs.channel,
      isEnabled: cs.isEnabled,
      maxChars: cs.maxChars,
    })),
    connections: client.connections.map((cc) => ({
      id: cc.id,
      channel: cc.channel,
      displayName: cc.displayName,
      externalAccountId: cc.externalAccountId,
      status: cc.status,
      tokenExpiresAt: cc.tokenExpiresAt,
      lastValidatedAt: cc.lastValidatedAt,
      lastError: cc.lastError,
      lastRefreshAt: cc.lastRefreshAt,
      refreshFailedAt: cc.refreshFailedAt,
      scopes: cc.scopes,
      createdAt: cc.createdAt,
    })),
    techStack: client.techStackConnections.map((ts) => ({
      id: ts.id,
      providerKey: ts.providerKey,
      connectionStatus: ts.connectionStatus,
      lastError: ts.lastError,
      connectedAt: ts.connectedAt,
    })),
    analytics: client.workspaceAnalytics
      ? {
          totalPosts: client.workspaceAnalytics.totalPosts,
          totalPublishedPosts: client.workspaceAnalytics.totalPublishedPosts,
          avgEngagementRate: client.workspaceAnalytics.avgEngagementRate,
          topPlatform: client.workspaceAnalytics.topPlatform,
          lastCalculatedAt: client.workspaceAnalytics.lastCalculatedAt,
        }
      : null,
    recentDrafts: recentDrafts.map(formatDraftSummary),
    recentFailures,
  };
}

// ── Content Debugger ─────────────────────────────────────────────────────

export async function listDrafts({ search, status, channel, clientId, kind, limit = 50, cursor }) {
  const where = {};

  if (status) where.status = status;
  if (channel) where.channel = channel;
  if (clientId) where.clientId = clientId;
  if (kind) where.kind = kind;

  if (search) {
    where.OR = [
      { id: { equals: search } },
      { body: { contains: search, mode: "insensitive" } },
      { campaignName: { contains: search, mode: "insensitive" } },
    ];
  }

  const drafts = await prisma.draft.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      client: { select: { id: true, name: true } },
      draftAssets: {
        select: { asset: { select: { id: true, url: true, mimeType: true, status: true } } },
      },
    },
  });

  const hasMore = drafts.length > limit;
  const items = hasMore ? drafts.slice(0, limit) : drafts;

  return {
    items: items.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      clientName: d.client?.name || null,
      kind: d.kind,
      status: d.status,
      channel: d.channel,
      body: d.body?.slice(0, 200) || null,
      campaignName: d.campaignName,
      campaignType: d.campaignType,
      modelUsed: d.modelUsed,
      promptVersion: d.promptVersion,
      warnings: d.warnings,
      publishError: d.publishError,
      publishAttempts: d.publishAttempts,
      mediaUrl: d.mediaUrl,
      hasAssets: d.draftAssets.length > 0,
      assetCount: d.draftAssets.length,
      createdBy: d.createdBy,
      createdAt: d.createdAt,
      scheduledFor: d.scheduledFor,
      publishedAt: d.publishedAt,
    })),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

export async function getDraftDetail(draftId) {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: {
      client: { select: { id: true, name: true, industryKey: true } },
      draftAssets: {
        include: {
          asset: {
            select: {
              id: true,
              url: true,
              thumbnailUrl: true,
              mimeType: true,
              assetType: true,
              status: true,
              width: true,
              height: true,
              filename: true,
              source: true,
              errorMessage: true,
            },
          },
        },
        orderBy: { orderIndex: "asc" },
      },
      contentSources: {
        include: {
          dataItem: {
            select: { id: true, type: true, title: true, summary: true, status: true },
          },
          blueprint: {
            select: { id: true, slug: true, name: true, category: true },
          },
        },
      },
      moderationLogs: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { fromStatus: true, toStatus: true, actorSub: true, reason: true, createdAt: true },
      },
    },
  });

  if (!draft) return null;

  return {
    id: draft.id,
    clientId: draft.clientId,
    clientName: draft.client?.name || null,
    industryKey: draft.client?.industryKey || null,
    kind: draft.kind,
    status: draft.status,
    channel: draft.channel,
    bucketKey: draft.bucketKey,
    body: draft.body,
    hooks: draft.hooks,
    hashtags: draft.hashtags,
    cta: draft.cta,
    altText: draft.altText,
    imageGuidance: draft.imageGuidance,
    videoGuidance: draft.videoGuidance,
    variations: draft.variations,
    warnings: draft.warnings,
    generationGuidance: draft.generationGuidance,
    modelUsed: draft.modelUsed,
    promptVersion: draft.promptVersion,
    campaignId: draft.campaignId,
    campaignName: draft.campaignName,
    campaignType: draft.campaignType,
    campaignDay: draft.campaignDay,
    campaignOrder: draft.campaignOrder,
    campaignTotal: draft.campaignTotal,
    mediaUrl: draft.mediaUrl,
    mediaType: draft.mediaType,
    publishError: draft.publishError,
    publishAttempts: draft.publishAttempts,
    lastPublishAttemptAt: draft.lastPublishAttemptAt,
    publishSource: draft.publishSource,
    externalPostId: draft.externalPostId,
    externalPostUrl: draft.externalPostUrl,
    idempotencyKey: draft.idempotencyKey,
    performanceRating: draft.performanceRating,
    createdBy: draft.createdBy,
    approvedBy: draft.approvedBy,
    approvedAt: draft.approvedAt,
    rejectedReason: draft.rejectedReason,
    scheduledFor: draft.scheduledFor,
    publishedAt: draft.publishedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    assets: draft.draftAssets.map((da) => ({
      role: da.role,
      orderIndex: da.orderIndex,
      ...da.asset,
    })),
    sources: draft.contentSources.map((s) => ({
      dataItem: s.dataItem,
      blueprint: s.blueprint,
    })),
    moderationLog: draft.moderationLogs,
  };
}

// ── Integrations Monitor ─────────────────────────────────────────────────

export async function listConnections({ status, channel, clientId, limit = 100 }) {
  const where = {};
  if (status) where.status = status;
  if (channel) where.channel = channel;
  if (clientId) where.clientId = clientId;

  const connections = await prisma.channelConnection.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: {
      client: { select: { id: true, name: true } },
    },
  });

  return connections.map((cc) => ({
    id: cc.id,
    clientId: cc.clientId,
    clientName: cc.client?.name || null,
    channel: cc.channel,
    displayName: cc.displayName,
    externalAccountId: cc.externalAccountId,
    status: cc.status,
    tokenExpiresAt: cc.tokenExpiresAt,
    lastValidatedAt: cc.lastValidatedAt,
    lastRefreshAt: cc.lastRefreshAt,
    refreshFailedAt: cc.refreshFailedAt,
    lastError: cc.lastError,
    scopes: cc.scopes,
    createdAt: cc.createdAt,
    updatedAt: cc.updatedAt,
  }));
}

export async function listTechStackConnections({ clientId, status, limit = 100 }) {
  const where = {};
  if (clientId) where.workspaceId = clientId;
  if (status) where.connectionStatus = status;

  const connections = await prisma.workspaceTechStackConnection.findMany({
    where,
    orderBy: { connectedAt: "desc" },
    take: limit,
    include: {
      workspace: { select: { id: true, name: true, industryKey: true } },
    },
  });

  return connections.map((ts) => ({
    id: ts.id,
    workspaceId: ts.workspaceId,
    workspaceName: ts.workspace?.name || null,
    industryKey: ts.workspace?.industryKey || null,
    providerKey: ts.providerKey,
    connectionStatus: ts.connectionStatus,
    lastError: ts.lastError,
    connectedAt: ts.connectedAt,
  }));
}

// ── Publishing Monitor ───────────────────────────────────────────────────

export async function listPublishingActivity({ status, channel, clientId, limit = 50, cursor }) {
  const where = {};

  // Focus on publishing-relevant statuses
  if (status) {
    where.status = status;
  } else {
    where.status = { in: ["PUBLISHED", "FAILED", "SCHEDULED"] };
  }

  if (channel) where.channel = channel;
  if (clientId) where.clientId = clientId;

  const drafts = await prisma.draft.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: [
      { lastPublishAttemptAt: { sort: "desc", nulls: "last" } },
      { updatedAt: "desc" },
    ],
    include: {
      client: { select: { id: true, name: true } },
      draftAssets: {
        select: { asset: { select: { id: true, status: true, mimeType: true } } },
      },
    },
  });

  const hasMore = drafts.length > limit;
  const items = hasMore ? drafts.slice(0, limit) : drafts;

  return {
    items: items.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      clientName: d.client?.name || null,
      channel: d.channel,
      status: d.status,
      body: d.body?.slice(0, 120) || null,
      mediaUrl: d.mediaUrl,
      mediaType: d.mediaType,
      hasAssets: d.draftAssets.length > 0,
      assetStatuses: d.draftAssets.map((da) => da.asset.status),
      publishError: d.publishError,
      publishAttempts: d.publishAttempts,
      lastPublishAttemptAt: d.lastPublishAttemptAt,
      publishSource: d.publishSource,
      externalPostId: d.externalPostId,
      externalPostUrl: d.externalPostUrl,
      idempotencyKey: d.idempotencyKey,
      scheduledFor: d.scheduledFor,
      publishedAt: d.publishedAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDraftSummary(d) {
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    channel: d.channel,
    body: d.body?.slice(0, 120) || null,
    campaignName: d.campaignName,
    publishError: d.publishError,
    warnings: d.warnings,
    modelUsed: d.modelUsed,
    createdAt: d.createdAt,
    scheduledFor: d.scheduledFor,
    publishedAt: d.publishedAt,
  };
}
