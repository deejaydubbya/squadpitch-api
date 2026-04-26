import { Router } from "express";
import { requireInternalAccess, requireAdminRole } from "../../middleware/requireRole.js";
import { sendError } from "../../lib/apiErrors.js";
import * as service from "./internal.service.js";
import * as extService from "./externalServices.service.js";
import * as betaService from "./betaOps.service.js";
import * as jobsService from "./jobs.service.js";
import * as webhooksService from "./webhooks.service.js";
import * as systemHealthService from "./systemHealth.service.js";
import * as configService from "./config.service.js";

export const internalRouter = Router();

const BASE = "/api/v1/internal";

// All internal routes require admin or developer role
internalRouter.use(BASE, requireInternalAccess);

// ── Health & Auth ────────────────────────────────────────────────────────

internalRouter.get(`${BASE}/health`, (_req, res) => {
  res.json(service.getHealth());
});

internalRouter.get(`${BASE}/me`, (req, res) => {
  res.json(service.getUserWithRoles(req.user, req.roles));
});

// ── Workspace Inspector ──────────────────────────────────────────────────

internalRouter.get(`${BASE}/workspaces`, async (req, res, next) => {
  try {
    const { search, status, limit, cursor } = req.query;
    const result = await service.listWorkspaces({
      search: search || undefined,
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      cursor: cursor || undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/workspaces/:id`, async (req, res, next) => {
  try {
    const detail = await service.getWorkspaceDetail(req.params.id);
    if (!detail) return sendError(res, 404, "NOT_FOUND", "Workspace not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

internalRouter.delete(`${BASE}/workspaces`, requireInternalAccess, async (req, res, next) => {
  try {
    const result = await service.deleteAllWorkspaces();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Content Debugger ─────────────────────────────────────────────────────

internalRouter.get(`${BASE}/drafts`, async (req, res, next) => {
  try {
    const { search, status, channel, clientId, kind, limit, cursor } = req.query;
    const result = await service.listDrafts({
      search: search || undefined,
      status: status || undefined,
      channel: channel || undefined,
      clientId: clientId || undefined,
      kind: kind || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      cursor: cursor || undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/drafts/:id`, async (req, res, next) => {
  try {
    const detail = await service.getDraftDetail(req.params.id);
    if (!detail) return sendError(res, 404, "NOT_FOUND", "Draft not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// ── Integrations Monitor ─────────────────────────────────────────────────

internalRouter.get(`${BASE}/connections`, async (req, res, next) => {
  try {
    const { status, channel, clientId, limit } = req.query;
    const result = await service.listConnections({
      status: status || undefined,
      channel: channel || undefined,
      clientId: clientId || undefined,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json({ items: result });
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/connections/tech-stack`, async (req, res, next) => {
  try {
    const { clientId, status, limit } = req.query;
    const result = await service.listTechStackConnections({
      clientId: clientId || undefined,
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json({ items: result });
  } catch (err) {
    next(err);
  }
});

// ── Publishing Monitor ───────────────────────────────────────────────────

internalRouter.get(`${BASE}/publishing`, async (req, res, next) => {
  try {
    const { status, channel, clientId, limit, cursor } = req.query;
    const result = await service.listPublishingActivity({
      status: status || undefined,
      channel: channel || undefined,
      clientId: clientId || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      cursor: cursor || undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── External Services ────────────────────────────────────────────────────

internalRouter.get(`${BASE}/services`, async (req, res, next) => {
  try {
    const { category, status } = req.query;
    const items = await extService.listServices({
      category: category || undefined,
      status: status || undefined,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/services/summary`, async (req, res, next) => {
  try {
    const summary = await extService.getServicesSummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/services/:id`, async (req, res, next) => {
  try {
    const svc = await extService.getService(req.params.id);
    if (!svc) return sendError(res, 404, "NOT_FOUND", "Service not found");
    res.json(svc);
  } catch (err) {
    next(err);
  }
});

// Admin-only: create, update, delete
internalRouter.post(`${BASE}/services`, requireAdminRole, async (req, res, next) => {
  try {
    const svc = await extService.createService(req.body);
    res.status(201).json(svc);
  } catch (err) {
    next(err);
  }
});

internalRouter.patch(`${BASE}/services/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const svc = await extService.updateService(req.params.id, req.body);
    if (!svc) return sendError(res, 404, "NOT_FOUND", "Service not found");
    res.json(svc);
  } catch (err) {
    next(err);
  }
});

internalRouter.delete(`${BASE}/services/:id`, requireAdminRole, async (req, res, next) => {
  try {
    await extService.deleteService(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Usage snapshot
internalRouter.post(`${BASE}/services/:id/usage`, requireAdminRole, async (req, res, next) => {
  try {
    const snapshot = await extService.addUsageSnapshot(req.params.id, req.body);
    res.status(201).json(snapshot);
  } catch (err) {
    next(err);
  }
});

// Refresh auto-derived usage (OpenAI, Fal budget data)
internalRouter.post(`${BASE}/services/refresh`, requireAdminRole, async (req, res, next) => {
  try {
    await extService.refreshDerivedUsage();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Seed initial service records
internalRouter.post(`${BASE}/services/seed`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await extService.seedServices();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Beta Ops ─────────────────────────────────────────────────────────────

// Summary
internalRouter.get(`${BASE}/beta/summary`, async (req, res, next) => {
  try {
    const summary = await betaService.getBetaSummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Testers
internalRouter.get(`${BASE}/beta/testers`, async (req, res, next) => {
  try {
    const { search, status, cohort, tag, priority, limit } = req.query;
    const items = await betaService.listTesters({
      search: search || undefined,
      status: status || undefined,
      cohort: cohort || undefined,
      tag: tag || undefined,
      priority: priority || undefined,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/beta/testers/:id`, async (req, res, next) => {
  try {
    const tester = await betaService.getTesterWithContext(req.params.id);
    if (!tester) return sendError(res, 404, "NOT_FOUND", "Tester not found");
    res.json(tester);
  } catch (err) {
    next(err);
  }
});

internalRouter.post(`${BASE}/beta/testers`, requireAdminRole, async (req, res, next) => {
  try {
    const tester = await betaService.createTester(req.body);
    res.status(201).json(tester);
  } catch (err) {
    next(err);
  }
});

internalRouter.patch(`${BASE}/beta/testers/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const tester = await betaService.updateTester(req.params.id, req.body);
    res.json(tester);
  } catch (err) {
    next(err);
  }
});

internalRouter.delete(`${BASE}/beta/testers/:id`, requireAdminRole, async (req, res, next) => {
  try {
    await betaService.deleteTester(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Feedback
internalRouter.get(`${BASE}/beta/feedback`, async (req, res, next) => {
  try {
    const { search, status, type, severity, needsFollowUp, testerId, limit, cursor } = req.query;
    const result = await betaService.listFeedback({
      search: search || undefined,
      status: status || undefined,
      type: type || undefined,
      severity: severity || undefined,
      needsFollowUp: needsFollowUp || undefined,
      testerId: testerId || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      cursor: cursor || undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/beta/feedback/:id`, async (req, res, next) => {
  try {
    const fb = await betaService.getFeedback(req.params.id);
    if (!fb) return sendError(res, 404, "NOT_FOUND", "Feedback not found");
    res.json(fb);
  } catch (err) {
    next(err);
  }
});

// Feedback submission — open to any authenticated internal user
internalRouter.post(`${BASE}/beta/feedback`, async (req, res, next) => {
  try {
    const fb = await betaService.createFeedback({
      ...req.body,
      userId: req.body.userId || req.auth?.payload?.sub,
    });
    res.status(201).json(fb);
  } catch (err) {
    next(err);
  }
});

// Triage / update feedback — admin only
internalRouter.patch(`${BASE}/beta/feedback/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const fb = await betaService.updateFeedback(req.params.id, req.body);
    res.json(fb);
  } catch (err) {
    next(err);
  }
});

internalRouter.delete(`${BASE}/beta/feedback/:id`, requireAdminRole, async (req, res, next) => {
  try {
    await betaService.deleteFeedback(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Jobs Monitor ────────────────────────────────────────────────────────

internalRouter.get(`${BASE}/jobs/summary`, async (req, res, next) => {
  try {
    const summary = await jobsService.getQueueSummary();
    res.json({ items: summary });
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/jobs`, async (req, res, next) => {
  try {
    const { queue, status, type, limit, offset } = req.query;
    const result = await jobsService.listJobs({
      queue: queue || undefined,
      status: status || "failed",
      type: type || undefined,
      limit: limit ? parseInt(limit, 10) : 25,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/jobs/:queue/:jobId`, async (req, res, next) => {
  try {
    const detail = await jobsService.getJobDetail(req.params.queue, req.params.jobId);
    if (!detail) return sendError(res, 404, "NOT_FOUND", "Job not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

internalRouter.post(`${BASE}/jobs/:queue/:jobId/retry`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await jobsService.retryJob(req.params.queue, req.params.jobId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.delete(`${BASE}/jobs/:queue/:jobId`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await jobsService.removeJob(req.params.queue, req.params.jobId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Webhooks Monitor ────────────────────────────────────────────────────

internalRouter.get(`${BASE}/webhooks/summary`, async (req, res, next) => {
  try {
    const summary = await webhooksService.getWebhookSummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/webhooks/endpoints`, async (req, res, next) => {
  try {
    const { status, search, limit } = req.query;
    const items = await webhooksService.listEndpoints({
      status: status || undefined,
      search: search || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/webhooks/endpoints/:id`, async (req, res, next) => {
  try {
    const detail = await webhooksService.getEndpointDetail(req.params.id);
    if (!detail) return sendError(res, 404, "NOT_FOUND", "Webhook endpoint not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

internalRouter.patch(`${BASE}/webhooks/endpoints/:id/toggle`, requireAdminRole, async (req, res, next) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      return sendError(res, 400, "INVALID_INPUT", "isActive must be a boolean");
    }
    const result = await webhooksService.toggleEndpoint(req.params.id, isActive);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/webhooks/deliveries`, async (req, res, next) => {
  try {
    const { status, eventType, endpointId, userId, limit, cursor } = req.query;
    const result = await webhooksService.listDeliveries({
      status: status || undefined,
      eventType: eventType || undefined,
      endpointId: endpointId || undefined,
      webhookUserId: userId || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      cursor: cursor || undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/webhooks/deliveries/:id`, async (req, res, next) => {
  try {
    const detail = await webhooksService.getDeliveryDetail(req.params.id);
    if (!detail) return sendError(res, 404, "NOT_FOUND", "Delivery not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

internalRouter.post(`${BASE}/webhooks/deliveries/:id/replay`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await webhooksService.replayDelivery(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── System Health ───────────────────────────────────────────────────────

internalRouter.get(`${BASE}/system-health/summary`, async (req, res, next) => {
  try {
    const summary = await systemHealthService.getSystemHealthSummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// ── Config / Feature Flags ──────────────────────────────────────────────

internalRouter.get(`${BASE}/config/flags`, async (req, res, next) => {
  try {
    const { category, enabled, search, limit } = req.query;
    const items = await configService.listFlags({
      category: category || undefined,
      enabled: enabled === "true" ? true : enabled === "false" ? false : undefined,
      search: search || undefined,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/config/flags/:id`, async (req, res, next) => {
  try {
    const flag = await configService.getFlag(req.params.id);
    if (!flag) return sendError(res, 404, "NOT_FOUND", "Flag not found");
    res.json(flag);
  } catch (err) {
    next(err);
  }
});

internalRouter.post(`${BASE}/config/flags`, requireAdminRole, async (req, res, next) => {
  try {
    const adminId = req.auth?.payload?.sub || null;
    const flag = await configService.createFlag(req.body, adminId);
    res.status(201).json(flag);
  } catch (err) {
    next(err);
  }
});

internalRouter.patch(`${BASE}/config/flags/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const adminId = req.auth?.payload?.sub || null;
    const flag = await configService.updateFlag(req.params.id, req.body, adminId);
    res.json(flag);
  } catch (err) {
    next(err);
  }
});

internalRouter.patch(`${BASE}/config/flags/:id/toggle`, requireAdminRole, async (req, res, next) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return sendError(res, 400, "INVALID_INPUT", "enabled must be a boolean");
    }
    const adminId = req.auth?.payload?.sub || null;
    const flag = await configService.toggleFlag(req.params.id, enabled, adminId);
    res.json(flag);
  } catch (err) {
    next(err);
  }
});

internalRouter.delete(`${BASE}/config/flags/:id`, requireAdminRole, async (req, res, next) => {
  try {
    await configService.deleteFlag(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

internalRouter.post(`${BASE}/config/flags/seed`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await configService.seedFlags();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(`${BASE}/config/flags/evaluate/:key`, async (req, res, next) => {
  try {
    const { userId, workspaceId, cohort } = req.query;
    const result = await configService.evaluateFlag(req.params.key, {
      userId: userId || undefined,
      workspaceId: workspaceId || undefined,
      cohort: cohort || undefined,
    });
    res.json({ key: req.params.key, active: result });
  } catch (err) {
    next(err);
  }
});
