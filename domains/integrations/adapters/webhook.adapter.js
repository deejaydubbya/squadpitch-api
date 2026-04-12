// Webhook adapter — wraps the existing OutboundWebhook system.
//
// Queries OutboundWebhook table for the user, filters by subscribed events,
// and enqueues BullMQ delivery jobs (same path as today).

import { prisma } from "../../../prisma.js";
import { getNotificationQueue } from "../../../lib/queues.js";
import { BaseAdapter } from "./base.adapter.js";

export class WebhookAdapter extends BaseAdapter {
  name = "webhook";

  async handleEvent(userId, eventType, payload) {
    const hooks = await prisma.outboundWebhook.findMany({
      where: { userId, isActive: true },
      select: { id: true, targetUrl: true, secret: true, subscribedEvents: true },
    });

    if (!hooks.length) return [];

    const queue = getNotificationQueue();
    const results = [];

    for (const hook of hooks) {
      const events = Array.isArray(hook.subscribedEvents) ? hook.subscribedEvents : [];
      if (!events.includes(eventType)) continue;

      if (!queue) {
        results.push({
          integrationId: hook.id,
          status: "failed",
          error: "Queue unavailable",
        });
        continue;
      }

      try {
        await queue.add("send-notification-webhook", {
          webhookId: hook.id,
          targetUrl: hook.targetUrl,
          secret: hook.secret,
          eventType,
          payload,
          userId,
        });
        results.push({ integrationId: hook.id, status: "success" });
      } catch (err) {
        results.push({
          integrationId: hook.id,
          status: "failed",
          error: err.message,
        });
      }
    }

    return results;
  }
}
