// Outbound webhook CRUD + delivery log queries.

import crypto from "node:crypto";
import { prisma } from "../../prisma.js";

export async function getWebhooks(userId) {
  return prisma.outboundWebhook.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWebhook(userId, webhookId) {
  return prisma.outboundWebhook.findFirst({
    where: { id: webhookId, userId },
  });
}

export async function createWebhook(userId, { targetUrl, subscribedEvents }) {
  const secret = crypto.randomBytes(32).toString("hex");
  return prisma.outboundWebhook.create({
    data: {
      userId,
      targetUrl,
      secret,
      subscribedEvents: subscribedEvents ?? undefined,
    },
  });
}

export async function updateWebhook(userId, webhookId, data) {
  const update = {};
  if (data.targetUrl !== undefined) update.targetUrl = data.targetUrl;
  if (data.subscribedEvents !== undefined) update.subscribedEvents = data.subscribedEvents;
  if (typeof data.isActive === "boolean") update.isActive = data.isActive;

  return prisma.outboundWebhook.updateMany({
    where: { id: webhookId, userId },
    data: update,
  });
}

export async function deleteWebhook(userId, webhookId) {
  return prisma.outboundWebhook.deleteMany({
    where: { id: webhookId, userId },
  });
}

export async function getDeliveryLogs(webhookId, { limit = 20, offset = 0 } = {}) {
  return prisma.webhookDeliveryLog.findMany({
    where: { webhookId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
}

export async function createDeliveryLog(webhookId, eventType, requestBody) {
  return prisma.webhookDeliveryLog.create({
    data: { webhookId, eventType, requestBody },
  });
}

export async function updateDeliveryLog(logId, data) {
  return prisma.webhookDeliveryLog.update({
    where: { id: logId },
    data,
  });
}
