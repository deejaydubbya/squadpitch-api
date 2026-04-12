// Discord adapter — sends notification embeds to Discord webhooks.
//
// Queries the Integration table for type="discord",
// and enqueues BullMQ jobs for async delivery.

import { prisma } from "../../../prisma.js";
import { getNotificationQueue } from "../../../lib/queues.js";
import { BaseAdapter } from "./base.adapter.js";

export class DiscordAdapter extends BaseAdapter {
  name = "discord";

  async handleEvent(userId, eventType, payload) {
    const integrations = await prisma.integration.findMany({
      where: { userId, type: "discord", isActive: true },
      select: { id: true, config: true },
    });

    if (!integrations.length) return [];

    const queue = getNotificationQueue();
    const results = [];

    for (const integration of integrations) {
      if (!this.shouldHandle(integration.config, eventType)) continue;
      if (!queue) {
        results.push({
          integrationId: integration.id,
          status: "failed",
          error: "Queue unavailable",
        });
        continue;
      }

      try {
        await queue.add("send-integration-discord", {
          integrationId: integration.id,
          config: integration.config,
          eventType,
          payload,
        });
        results.push({ integrationId: integration.id, status: "success" });
      } catch (err) {
        results.push({
          integrationId: integration.id,
          status: "failed",
          error: err.message,
        });
      }
    }

    return results;
  }
}
