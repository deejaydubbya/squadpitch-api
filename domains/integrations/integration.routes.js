// Generic integration CRUD routes.
// Mounted under /api/v1/integrations
//
// These routes manage the Integration table (for future types like Notion, Sheets).
// Existing Slack and Webhook routes remain at their current paths.

import express from "express";
import {
  getIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  getIntegrationLogs,
  dispatchToAdapter,
} from "./integration.service.js";
import { getAdapter } from "./adapters/index.js";

export const integrationRouter = express.Router();

const BASE = "/api/v1/integrations";

// GET all integrations (optionally filter by type)
integrationRouter.get(BASE, async (req, res, next) => {
  try {
    const type = req.query.type || undefined;
    const integrations = await getIntegrations(req.user.id, { type });
    res.json({ integrations });
  } catch (err) {
    next(err);
  }
});

// GET single integration
integrationRouter.get(`${BASE}/:id`, async (req, res, next) => {
  try {
    const integration = await getIntegration(req.user.id, req.params.id);
    if (!integration) return res.status(404).json({ error: "Integration not found" });
    res.json({ integration });
  } catch (err) {
    next(err);
  }
});

// POST create integration
integrationRouter.post(BASE, async (req, res, next) => {
  try {
    const { type, name, config } = req.body;
    if (!type || !name) {
      return res.status(400).json({ error: "type and name are required" });
    }
    if (!getAdapter(type)) {
      return res.status(400).json({ error: `Unknown integration type: ${type}` });
    }
    const integration = await createIntegration(req.user.id, { type, name, config });
    res.status(201).json({ integration });
  } catch (err) {
    next(err);
  }
});

// PUT update integration
integrationRouter.put(`${BASE}/:id`, async (req, res, next) => {
  try {
    const { name, config, isActive } = req.body;
    await updateIntegration(req.user.id, req.params.id, { name, config, isActive });
    const updated = await getIntegration(req.user.id, req.params.id);
    if (!updated) return res.status(404).json({ error: "Integration not found" });
    res.json({ integration: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE integration
integrationRouter.delete(`${BASE}/:id`, async (req, res, next) => {
  try {
    await deleteIntegration(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET logs for an integration
integrationRouter.get(`${BASE}/:id/logs`, async (req, res, next) => {
  try {
    const integration = await getIntegration(req.user.id, req.params.id);
    if (!integration) return res.status(404).json({ error: "Integration not found" });

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const logs = await getIntegrationLogs(req.params.id, { limit, offset });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// POST test integration
integrationRouter.post(`${BASE}/:id/test`, async (req, res, next) => {
  try {
    const integration = await getIntegration(req.user.id, req.params.id);
    if (!integration) return res.status(404).json({ error: "Integration not found" });

    const results = await dispatchToAdapter(
      integration.type,
      req.user.id,
      "TEST",
      { message: "Test event from Squadpitch" }
    );
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// POST retry a failed integration log entry
integrationRouter.post(`${BASE}/:id/retry/:logId`, async (req, res, next) => {
  try {
    const integration = await getIntegration(req.user.id, req.params.id);
    if (!integration) return res.status(404).json({ error: "Integration not found" });

    const { getIntegrationLog } = await import("./integration.service.js");
    const log = await getIntegrationLog(req.params.logId);
    if (!log || log.integrationId !== integration.id) {
      return res.status(404).json({ error: "Log entry not found" });
    }
    if (log.status !== "failed") {
      return res.status(400).json({ error: "Only failed deliveries can be retried" });
    }

    const results = await dispatchToAdapter(
      integration.type,
      req.user.id,
      log.eventType,
      { message: "Retry from Squadpitch", retryOf: log.id }
    );
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// GET available adapter types
integrationRouter.get(`${BASE}/types/available`, async (_req, res, next) => {
  try {
    const { getAdapters } = await import("./adapters/index.js");
    const types = [...getAdapters().keys()];
    res.json({ types });
  } catch (err) {
    next(err);
  }
});
