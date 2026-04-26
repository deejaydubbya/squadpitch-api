// Admin-level webhook inspection service.
// Reuses the existing OutboundWebhook + WebhookDeliveryLog tables.

import { prisma } from "../../prisma.js";
import { getNotificationQueue } from "../../lib/queues.js";

// ── Payload Sanitization ────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "accessToken", "refreshToken", "token", "secret", "auth",
  "p256dh", "webhookUrl", "targetUrl", "endpoint", "password",
  "apiKey", "apiSecret", "clientSecret",
]);

function sanitizePayload(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizePayload);

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizePayload(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Summary ─────────────────────────────────────────────────────────────

export async function getWebhookSummary() {
  const [endpoints, deliveryCounts] = await Promise.all([
    prisma.outboundWebhook.groupBy({
      by: ["isActive"],
      _count: true,
    }),
    prisma.webhookDeliveryLog.groupBy({
      by: ["status"],
      _count: true,
    }),
  ]);

  const totalEndpoints = endpoints.reduce((s, e) => s + e._count, 0);
  const activeEndpoints = endpoints.find((e) => e.isActive === true)?._count || 0;
  const inactiveEndpoints = totalEndpoints - activeEndpoints;

  const deliveriesByStatus = {};
  let totalDeliveries = 0;
  for (const row of deliveryCounts) {
    deliveriesByStatus[row.status] = row._count;
    totalDeliveries += row._count;
  }

  // Recent failures (last 24h)
  const recentFailedCount = await prisma.webhookDeliveryLog.count({
    where: {
      status: "failed",
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });

  return {
    totalEndpoints,
    activeEndpoints,
    inactiveEndpoints,
    totalDeliveries,
    deliveriesByStatus,
    recentFailed24h: recentFailedCount,
  };
}

// ── Endpoints ───────────────────────────────────────────────────────────

export async function listEndpoints({ status, search, limit = 50 }) {
  const where = {};

  if (status === "active") where.isActive = true;
  else if (status === "inactive") where.isActive = false;

  if (search) {
    where.OR = [
      { id: { equals: search } },
      { userId: { contains: search, mode: "insensitive" } },
      { targetUrl: { contains: search, mode: "insensitive" } },
    ];
  }

  const endpoints = await prisma.outboundWebhook.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      _count: { select: { deliveryLogs: true } },
    },
  });

  // Get recent delivery stats per endpoint
  const endpointIds = endpoints.map((e) => e.id);
  const recentStats = endpointIds.length > 0
    ? await prisma.webhookDeliveryLog.groupBy({
        by: ["webhookId", "status"],
        where: {
          webhookId: { in: endpointIds },
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        _count: true,
      })
    : [];

  const statsMap = {};
  for (const row of recentStats) {
    if (!statsMap[row.webhookId]) statsMap[row.webhookId] = {};
    statsMap[row.webhookId][row.status] = row._count;
  }

  return endpoints.map((ep) => ({
    id: ep.id,
    userId: ep.userId,
    targetUrl: ep.targetUrl,
    hasSecret: Boolean(ep.secret),
    subscribedEvents: ep.subscribedEvents || [],
    isActive: ep.isActive,
    totalDeliveries: ep._count.deliveryLogs,
    recentStats: statsMap[ep.id] || {},
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  }));
}

export async function getEndpointDetail(endpointId) {
  const endpoint = await prisma.outboundWebhook.findUnique({
    where: { id: endpointId },
    include: {
      _count: { select: { deliveryLogs: true } },
    },
  });

  if (!endpoint) return null;

  // Recent deliveries for this endpoint
  const recentDeliveries = await prisma.webhookDeliveryLog.findMany({
    where: { webhookId: endpointId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Delivery stats grouped by status
  const stats = await prisma.webhookDeliveryLog.groupBy({
    by: ["status"],
    where: { webhookId: endpointId },
    _count: true,
  });

  const statsByStatus = {};
  for (const row of stats) {
    statsByStatus[row.status] = row._count;
  }

  return {
    id: endpoint.id,
    userId: endpoint.userId,
    targetUrl: endpoint.targetUrl,
    hasSecret: Boolean(endpoint.secret),
    subscribedEvents: endpoint.subscribedEvents || [],
    isActive: endpoint.isActive,
    totalDeliveries: endpoint._count.deliveryLogs,
    statsByStatus,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    recentDeliveries: recentDeliveries.map(formatDelivery),
  };
}

// ── Toggle endpoint active/inactive ─────────────────────────────────────

export async function toggleEndpoint(endpointId, isActive) {
  const endpoint = await prisma.outboundWebhook.findUnique({
    where: { id: endpointId },
  });
  if (!endpoint) throw new Error(`Endpoint "${endpointId}" not found`);

  await prisma.outboundWebhook.update({
    where: { id: endpointId },
    data: { isActive },
  });

  return { ok: true, endpointId, isActive };
}

// ── Deliveries ──────────────────────────────────────────────────────────

export async function listDeliveries({ status, eventType, endpointId, webhookUserId, limit = 50, cursor }) {
  const where = {};

  if (status) where.status = status;
  if (eventType) where.eventType = eventType;
  if (endpointId) where.webhookId = endpointId;

  // Filter by workspace/user through the endpoint relationship
  if (webhookUserId) {
    where.webhook = { userId: { contains: webhookUserId, mode: "insensitive" } };
  }

  const deliveries = await prisma.webhookDeliveryLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      webhook: {
        select: {
          id: true,
          targetUrl: true,
          userId: true,
          isActive: true,
        },
      },
    },
  });

  const hasMore = deliveries.length > limit;
  const items = (hasMore ? deliveries.slice(0, limit) : deliveries).map(formatDeliveryWithEndpoint);
  const nextCursor = hasMore ? items[items.length - 1]?.id : null;

  return { items, nextCursor };
}

export async function getDeliveryDetail(deliveryId) {
  const delivery = await prisma.webhookDeliveryLog.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: {
        select: {
          id: true,
          targetUrl: true,
          userId: true,
          isActive: true,
          subscribedEvents: true,
        },
      },
    },
  });

  if (!delivery) return null;

  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    eventType: delivery.eventType,
    requestBody: sanitizePayload(delivery.requestBody),
    requestHeaders: delivery.requestHeaders || null,
    responseStatus: delivery.responseStatus,
    responseBody: delivery.responseBody,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    deliveredAt: delivery.deliveredAt || null,
    replayOfId: delivery.replayOfId || null,
    createdAt: delivery.createdAt,
    endpoint: delivery.webhook
      ? {
          id: delivery.webhook.id,
          targetUrl: delivery.webhook.targetUrl,
          userId: delivery.webhook.userId,
          isActive: delivery.webhook.isActive,
          subscribedEvents: delivery.webhook.subscribedEvents || [],
        }
      : null,
  };
}

// ── Replay ──────────────────────────────────────────────────────────────

export async function replayDelivery(deliveryId) {
  const delivery = await prisma.webhookDeliveryLog.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: true,
    },
  });

  if (!delivery) throw new Error(`Delivery "${deliveryId}" not found`);
  if (delivery.status !== "failed") {
    throw new Error(`Only failed deliveries can be replayed (current: ${delivery.status})`);
  }
  if (!delivery.webhook) {
    throw new Error("Webhook endpoint no longer exists");
  }
  if (!delivery.webhook.isActive) {
    throw new Error("Webhook endpoint is inactive — activate it first");
  }

  // Enqueue a new delivery job via the notification queue
  const queue = getNotificationQueue();
  if (!queue) {
    throw new Error("Notification queue unavailable — Redis may be down");
  }

  await queue.add("send-notification-webhook", {
    webhookId: delivery.webhook.id,
    targetUrl: delivery.webhook.targetUrl,
    secret: delivery.webhook.secret,
    eventType: delivery.eventType,
    payload: delivery.requestBody,
    userId: delivery.webhook.userId,
    replayOfId: deliveryId,
  });

  return { ok: true, deliveryId, eventType: delivery.eventType };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatDelivery(d) {
  return {
    id: d.id,
    webhookId: d.webhookId,
    eventType: d.eventType,
    requestBody: sanitizePayload(d.requestBody),
    requestHeaders: d.requestHeaders || null,
    responseStatus: d.responseStatus,
    responseBody: d.responseBody,
    status: d.status,
    attemptCount: d.attemptCount,
    deliveredAt: d.deliveredAt || null,
    replayOfId: d.replayOfId || null,
    createdAt: d.createdAt,
  };
}

function formatDeliveryWithEndpoint(d) {
  return {
    ...formatDelivery(d),
    endpoint: d.webhook
      ? {
          id: d.webhook.id,
          targetUrl: d.webhook.targetUrl,
          userId: d.webhook.userId,
          isActive: d.webhook.isActive,
        }
      : null,
  };
}
