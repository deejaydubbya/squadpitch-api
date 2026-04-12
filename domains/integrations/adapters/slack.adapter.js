// Slack adapter — wraps the existing SlackConnection system.
//
// Queries SlackConnection for the user, checks subscribed events,
// and enqueues a BullMQ Slack delivery job (same path as today).

import { prisma } from "../../../prisma.js";
import { getNotificationQueue } from "../../../lib/queues.js";
import { BaseAdapter } from "./base.adapter.js";

export class SlackAdapter extends BaseAdapter {
  name = "slack";

  async handleEvent(userId, eventType, payload) {
    const conn = await prisma.slackConnection.findUnique({
      where: { userId },
      select: { id: true, webhookUrl: true, isActive: true, subscribedEvents: true },
    });

    if (!conn || !conn.isActive) return [];

    const events = Array.isArray(conn.subscribedEvents) ? conn.subscribedEvents : [];
    if (!events.includes(eventType)) return [];

    const queue = getNotificationQueue();
    if (!queue) {
      return [{ integrationId: conn.id, status: "failed", error: "Queue unavailable" }];
    }

    try {
      await queue.add("send-notification-slack", {
        webhookUrl: conn.webhookUrl,
        eventType,
        payload,
      });
      return [{ integrationId: conn.id, status: "success" }];
    } catch (err) {
      return [{ integrationId: conn.id, status: "failed", error: err.message }];
    }
  }
}
