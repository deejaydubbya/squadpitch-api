import { Router } from "express";
import { requireInternalAccess, requireAdminRole } from "../../middleware/requireRole.js";
import { sendError } from "../../lib/apiErrors.js";
import * as service from "./internal.service.js";
import * as extService from "./externalServices.service.js";
import * as betaService from "./betaOps.service.js";

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
