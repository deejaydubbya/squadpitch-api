// Slack adapter — reads from the generic Integration table (type = "slack").
//
// Config shape: { webhookUrl, channelName?, subscribedEvents? }
// Checks subscribed events and enqueues a BullMQ Slack delivery job.

import { prisma } from "../../../prisma.js";
import { getNotificationQueue } from "../../../lib/queues.js";
import { BaseAdapter } from "./base.adapter.js";

export class SlackAdapter extends BaseAdapter {
  name = "slack";

  async handleEvent(userId, eventType, payload) {
    const integration = await prisma.integration.findFirst({
      where: { userId, type: "slack", isActive: true },
    });

    if (!integration) return [];

    const config = integration.config ?? {};
    if (!config.webhookUrl) return [];
    if (!this.shouldHandle(config, eventType)) return [];

    const queue = getNotificationQueue();
    if (!queue) {
      return [{ integrationId: integration.id, status: "failed", error: "Queue unavailable" }];
    }

    try {
      await queue.add("send-notification-slack", {
        webhookUrl: config.webhookUrl,
        eventType,
        payload,
      });
      return [{ integrationId: integration.id, status: "success" }];
    } catch (err) {
      return [{ integrationId: integration.id, status: "failed", error: err.message }];
    }
  }
}
