// Google Sheets adapter — appends rows to a spreadsheet on events.
//
// Queries the Integration table for type="google_sheets", checks active status,
// and enqueues BullMQ jobs for async delivery with retries.

import { prisma } from "../../../prisma.js";
import { getNotificationQueue } from "../../../lib/queues.js";
import { BaseAdapter } from "./base.adapter.js";

export class SheetsAdapter extends BaseAdapter {
  name = "google_sheets";

  async handleEvent(userId, eventType, payload) {
    const integrations = await prisma.integration.findMany({
      where: { userId, type: "google_sheets", isActive: true },
      select: { id: true, config: true },
    });

    if (!integrations.length) return [];

    const queue = getNotificationQueue();
    const results = [];

    for (const integration of integrations) {
      if (!queue) {
        results.push({
          integrationId: integration.id,
          status: "failed",
          error: "Queue unavailable",
        });
        continue;
      }

      try {
        await queue.add("send-integration-sheets", {
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
