// Unified integration dispatcher + CRUD.
//
// This service is the single entry point for dispatching events to all
// integration types (webhook, slack, notion, sheets, etc.).
//
// It wraps the existing per-type dispatchers through the adapter pattern
// and logs every dispatch result to the IntegrationLog table.

import { prisma } from "../../prisma.js";
import { getAdapters, getAdapter } from "./adapters/index.js";

// ── CRUD ─────────────────────────────────────────────────────────────

export async function getIntegrations(userId, { type } = {}) {
  const where = { userId };
  if (type) where.type = type;
  return prisma.integration.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
}

export async function getIntegration(userId, integrationId) {
  return prisma.integration.findFirst({
    where: { id: integrationId, userId },
  });
}

export async function createIntegration(userId, { type, name, config }) {
  return prisma.integration.create({
    data: { userId, type, name, config: config ?? {} },
  });
}

export async function updateIntegration(userId, integrationId, data) {
  const update = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.config !== undefined) update.config = data.config;
  if (typeof data.isActive === "boolean") update.isActive = data.isActive;

  return prisma.integration.updateMany({
    where: { id: integrationId, userId },
    data: update,
  });
}

export async function deleteIntegration(userId, integrationId) {
  return prisma.integration.deleteMany({
    where: { id: integrationId, userId },
  });
}

// ── Logs ─────────────────────────────────────────────────────────────

export async function getIntegrationLogs(integrationId, { limit = 20, offset = 0 } = {}) {
  return prisma.integrationLog.findMany({
    where: { integrationId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
}

export async function getIntegrationLog(logId) {
  return prisma.integrationLog.findUnique({ where: { id: logId } });
}

// ── Dispatch ─────────────────────────────────────────────────────────

/**
 * Dispatch an event to ALL active integration adapters for a user.
 *
 * Runs every registered adapter in parallel, collects results,
 * and writes IntegrationLog entries for any adapter-managed integrations.
 *
 * Safe to call fire-and-forget — never throws to the caller.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.eventType
 * @param {object} params.payload
 */
export async function dispatchEvent({ userId, eventType, payload }) {
  try {
    const adapters = getAdapters();
    const promises = [];

    for (const [, adapter] of adapters) {
      promises.push(
        adapter
          .handleEvent(userId, eventType, payload)
          .catch((err) => {
            console.error(
              `[INTEGRATION] ${adapter.name} adapter error: ${err.message}`
            );
            return [];
          })
      );
    }

    const resultSets = await Promise.all(promises);

    // Log results for Integration-table-managed integrations (future types).
    // Existing Slack/Webhook have their own logging (WebhookDeliveryLog, etc.),
    // so we only log entries that carry an integrationId from the Integration table.
    for (const results of resultSets) {
      for (const r of results) {
        if (!r.integrationId) continue;

        // Only log if this ID belongs to the Integration table.
        // (Slack/Webhook adapters return their own model IDs which won't match.)
        try {
          await prisma.integrationLog.create({
            data: {
              integrationId: r.integrationId,
              eventType,
              status: r.status,
              responseData: r.responseData ?? null,
              errorMessage: r.error ?? null,
            },
          });
        } catch {
          // Best-effort logging — don't crash dispatch.
        }
      }
    }
  } catch (err) {
    console.error(`[INTEGRATION] dispatchEvent error: ${err.message}`);
  }
}

/**
 * Dispatch an event to a single adapter type.
 * Useful for testing or targeted re-delivery.
 *
 * @param {string} adapterType
 * @param {string} userId
 * @param {string} eventType
 * @param {object} payload
 * @returns {Promise<import("./adapters/base.adapter.js").AdapterResult[]>}
 */
export async function dispatchToAdapter(adapterType, userId, eventType, payload) {
  const adapter = getAdapter(adapterType);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${adapterType}`);
  }
  return adapter.handleEvent(userId, eventType, payload);
}
