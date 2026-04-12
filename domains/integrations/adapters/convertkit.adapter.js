// ConvertKit adapter — creates draft broadcasts on events.
//
// Queries the Integration table for type="convertkit",
// and enqueues BullMQ jobs for async delivery.

import { prisma } from "../../../prisma.js";
import { getNotificationQueue } from "../../../lib/queues.js";
import { BaseAdapter } from "./base.adapter.js";

export class ConvertkitAdapter extends BaseAdapter {
  name = "convertkit";

  async handleEvent(userId, eventType, payload) {
    const integrations = await prisma.integration.findMany({
      where: { userId, type: "convertkit", isActive: true },
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
        await queue.add("send-integration-convertkit", {
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
