// Slack connection CRUD + notification dispatch.

import { prisma } from "../../prisma.js";

export async function getSlackConnection(userId) {
  return prisma.slackConnection.findUnique({ where: { userId } });
}

export async function upsertSlackConnection(userId, { webhookUrl, channelName, subscribedEvents }) {
  return prisma.slackConnection.upsert({
    where: { userId },
    create: {
      userId,
      webhookUrl,
      channelName: channelName ?? null,
      subscribedEvents: subscribedEvents ?? undefined,
    },
    update: {
      webhookUrl,
      channelName: channelName ?? null,
      ...(subscribedEvents ? { subscribedEvents } : {}),
    },
  });
}

export async function updateSlackEvents(userId, subscribedEvents) {
  return prisma.slackConnection.update({
    where: { userId },
    data: { subscribedEvents },
  });
}

export async function toggleSlackActive(userId, isActive) {
  return prisma.slackConnection.update({
    where: { userId },
    data: { isActive },
  });
}

export async function deleteSlackConnection(userId) {
  return prisma.slackConnection.deleteMany({ where: { userId } });
}
