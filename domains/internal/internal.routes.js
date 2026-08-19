import { Router } from "express";
import {
  requireInternalAccess,
  requireAdminRole,
} from "../../middleware/requireRole.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
import { writeAudit } from "../../lib/auditLog.js";
import * as service from "./internal.service.js";
import * as extService from "./externalServices.service.js";
import * as betaService from "./betaOps.service.js";
import * as jobsService from "./jobs.service.js";
import * as webhooksService from "./webhooks.service.js";
import * as systemHealthService from "./systemHealth.service.js";
import * as configService from "./config.service.js";
import * as aiObservabilityService from "../aiPlatform/observability.service.js";
import { setAiProvenanceHeaders } from "../aiPlatform/executionProvenance.js";
import * as aiExperimentationService from "../aiPlatform/experimentation.service.js";
import { syncMetricsForDraft } from "../studio/metricsSyncService.js";
import { prisma } from "../../prisma.js";
import { logEvent } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import {
  CreateExternalServiceSchema,
  UpdateExternalServiceSchema,
  ExternalServiceUsageSnapshotSchema,
  CreateBetaTesterSchema,
  UpdateBetaTesterSchema,
  CreateBetaFeedbackSchema,
  UpdateBetaFeedbackSchema,
  CreateFeatureFlagSchema,
  UpdateFeatureFlagSchema,
  ToggleFeatureFlagSchema,
  ToggleWebhookEndpointSchema,
} from "./internal.schemas.js";
import { CreateProspectSchema, PopulateProspectSchema, PrepareProspectSchema, ProspectListQuerySchema, UpdateProspectPreviewSchema } from "../prospects/prospect.schemas.js";
import { UpdateFeedbackSchema } from "../feedback/feedback.schemas.js";
import { updateAdminFeedback } from "../feedback/feedback.service.js";
import * as prospectService from "../prospects/prospect.service.js";
import * as outreachService from "../prospects/outreach.service.js";
import { z } from "zod";

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

internalRouter.get(`${BASE}/prospects`, requireAdminRole, async (req, res, next) => {
  try {
    const parsed = ProspectListQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error);
    res.json({ items: await prospectService.listProspects(parsed.data) });
  } catch (err) { next(err); }
});

internalRouter.post(`${BASE}/prospects`, requireAdminRole, async (req, res, next) => {
  try {
    if (process.env.PROSPECT_WORKSPACES_ENABLED === "false") return sendError(res, 503, "PROSPECTS_DISABLED", "Prospect workspace creation is temporarily unavailable");
    const parsed = CreateProspectSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const result = await prospectService.createProspect(parsed.data, req.auth0Sub);
    await writeAudit(req, { action: "prospect.workspace.created", resourceType: "ProspectWorkspace", resourceId: result.id, metadata: { clientId: result.clientId, industryKey: result.industryKey } });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

internalRouter.get(`${BASE}/prospects/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await prospectService.getProspect(req.params.id);
    if (!result) return sendError(res, 404, "NOT_FOUND", "Prospect workspace not found");
    res.json(result);
  } catch (err) { next(err); }
});

internalRouter.post(`${BASE}/prospects/:id/populate`, requireAdminRole, async (req, res, next) => {
  try {
    const parsed = PopulateProspectSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const result = await prospectService.populateProspect(req.params.id, parsed.data, req.auth0Sub);
    await writeAudit(req, { action: "prospect.workspace.populated", resourceType: "ProspectWorkspace", resourceId: req.params.id, metadata: { itemCreated: Boolean(result.itemId), draftCount: result.draftIds.length } });
    res.json(result);
  } catch (err) { next(err); }
});

internalRouter.post(`${BASE}/prospects/:id/prepare`, requireAdminRole, async (req, res, next) => {
  try {
    const parsed = PrepareProspectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const result = await prospectService.startProspectPreparation(req.params.id, parsed.data, req.auth0Sub);
    await writeAudit(req, { action: result.attached ? "prospect.preparation.attached" : "prospect.preparation.started", resourceType: "ProspectPreparationRun", resourceId: result.run.id, metadata: { prospectWorkspaceId: req.params.id } });
    res.status(result.attached ? 200 : 202).json({ run: result.run, attached: result.attached });
  } catch (err) { next(err); }
});

internalRouter.put(`${BASE}/prospects/:id/preview-items`, requireAdminRole, async (req, res, next) => {
  try {
    const parsed = UpdateProspectPreviewSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const result = await prospectService.updatePreviewSelection(req.params.id, parsed.data.items, req.auth0Sub);
    await writeAudit(req, { action: "prospect.preview.selection_updated", resourceType: "ProspectWorkspace", resourceId: req.params.id, metadata: { itemCount: result.items.length } });
    res.json(result);
  } catch (err) { next(err); }
});

internalRouter.post(`${BASE}/prospects/:id/claim-token`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await prospectService.rotateClaim(req.params.id, Number(req.body?.ttlDays) || undefined);
    await writeAudit(req, { action: "prospect.claim.rotated", resourceType: "ProspectWorkspace", resourceId: req.params.id });
    res.json(result);
  } catch (err) { next(err); }
});

internalRouter.delete(`${BASE}/prospects/:id/claim-token`, requireAdminRole, async (req, res, next) => {
  try {
    await prospectService.revokeClaim(req.params.id);
    await writeAudit(req, { action: "prospect.claim.revoked", resourceType: "ProspectWorkspace", resourceId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

internalRouter.post(`${BASE}/prospects/:id/preview-token`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await prospectService.rotatePreview(req.params.id);
    await writeAudit(req, { action: "prospect.preview.rotated", resourceType: "ProspectWorkspace", resourceId: req.params.id });
    res.json(result);
  } catch (err) { next(err); }
});

internalRouter.delete(`${BASE}/prospects/:id/preview-token`, requireAdminRole, async (req, res, next) => {
  try {
    await prospectService.revokePreview(req.params.id);
    await writeAudit(req, { action: "prospect.preview.revoked", resourceType: "ProspectWorkspace", resourceId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

const DiscoverySchema = z.object({ sourceUrl: z.string().url(), maxPages: z.coerce.number().int().min(1).max(25).optional(), maxAgents: z.coerce.number().int().min(1).max(250).optional() });
const EmailDraftSchema = z.object({ subject: z.string().max(240).optional(), body: z.string().max(20_000).optional(), sendingAccountId: z.string().optional() });
const SendingAccountSchema = z.object({
  provider: z.enum(["SMTP", "GMAIL"]), displayName: z.string().min(1).max(120), fromEmail: z.string().email(), replyTo: z.string().email().optional().or(z.literal("")),
  smtpHost: z.string().min(1).optional(), smtpPort: z.coerce.number().int().min(1).max(65535).optional(), smtpUsername: z.string().optional(), smtpPassword: z.string().optional(),
  smtpSecure: z.boolean().default(true), enabled: z.boolean().default(true), isDefault: z.boolean().default(false), hourlyLimit: z.coerce.number().int().min(1).max(1000).default(25), dailyLimit: z.coerce.number().int().min(1).max(10000).default(100), delaySeconds: z.coerce.number().int().min(1).max(3600).default(60),
}).superRefine((value, ctx) => { if (value.provider === "SMTP") for (const key of ["smtpHost", "smtpPort", "smtpUsername", "smtpPassword"]) if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for SMTP` }); });
const UpdateSendingAccountSchema = z.object({ displayName: z.string().min(1).max(120).optional(), fromEmail: z.string().email().optional(), replyTo: z.string().email().nullable().optional(), smtpHost: z.string().min(1).optional(), smtpPort: z.coerce.number().int().min(1).max(65535).optional(), smtpUsername: z.string().optional(), smtpPassword: z.string().min(1).optional(), smtpSecure: z.boolean().optional(), enabled: z.boolean().optional(), isDefault: z.boolean().optional(), hourlyLimit: z.coerce.number().int().min(1).max(1000).optional(), dailyLimit: z.coerce.number().int().min(1).max(10000).optional(), delaySeconds: z.coerce.number().int().min(1).max(3600).optional() });

internalRouter.get(`${BASE}/agent-outreach`, requireAdminRole, async (_req, res, next) => { try { res.json(await outreachService.listPipeline()); } catch (err) { next(err); } });
internalRouter.post(`${BASE}/agent-outreach/discoveries/analyze`, requireAdminRole, async (req, res, next) => { try { const parsed = DiscoverySchema.pick({ sourceUrl: true }).safeParse(req.body); if (!parsed.success) return validationError(res, parsed.error); res.json(await outreachService.analyzeDiscoverySource(parsed.data.sourceUrl)); } catch (err) { next(err); } });
internalRouter.post(`${BASE}/agent-outreach/discoveries`, requireAdminRole, async (req, res, next) => { try { const parsed = DiscoverySchema.safeParse(req.body); if (!parsed.success) return validationError(res, parsed.error); res.status(201).json(await outreachService.discoverAgents(parsed.data.sourceUrl, req.auth0Sub, { maxPages: parsed.data.maxPages, maxAgents: parsed.data.maxAgents })); } catch (err) { next(err); } });
internalRouter.post(`${BASE}/agent-outreach/prospects/:id/preview`, requireAdminRole, async (req, res, next) => { try { res.status(202).json(await outreachService.generatePreview(req.params.id, req.auth0Sub)); } catch (err) { next(err); } });
internalRouter.post(`${BASE}/agent-outreach/prospects/:id/email`, requireAdminRole, async (req, res, next) => { try { const parsed = EmailDraftSchema.safeParse(req.body ?? {}); if (!parsed.success) return validationError(res, parsed.error); res.json(await outreachService.prepareEmail(req.params.id, parsed.data)); } catch (err) { next(err); } });
internalRouter.post(`${BASE}/agent-outreach/prospects/:id/send`, requireAdminRole, async (req, res, next) => { try { res.json(await outreachService.sendOutreachEmail(req.params.id, req.body?.sendingAccountId)); } catch (err) { next(err); } });
internalRouter.post(`${BASE}/agent-outreach/sending-accounts`, requireAdminRole, async (req, res, next) => { try { const parsed = SendingAccountSchema.safeParse(req.body); if (!parsed.success) return validationError(res, parsed.error); res.status(201).json(await outreachService.saveSendingAccount(parsed.data, req.auth0Sub)); } catch (err) { next(err); } });
internalRouter.post(`${BASE}/agent-outreach/sending-accounts/:id/test`, requireAdminRole, async (req, res, next) => { try { res.json(await outreachService.testSendingAccount(req.params.id)); } catch (err) { next(err); } });
internalRouter.patch(`${BASE}/agent-outreach/sending-accounts/:id`, requireAdminRole, async (req, res, next) => { try { const parsed = UpdateSendingAccountSchema.safeParse(req.body); if (!parsed.success) return validationError(res, parsed.error); res.json(await outreachService.updateSendingAccount(req.params.id, parsed.data)); } catch (err) { next(err); } });
internalRouter.delete(`${BASE}/agent-outreach/sending-accounts/:id`, requireAdminRole, async (req, res, next) => { try { await outreachService.deleteSendingAccount(req.params.id); res.status(204).end(); } catch (err) { next(err); } });

// Read-only, synthetic hosted-AI verification. This route never publishes,
// creates drafts, invokes integrations, or persists verification fixtures.
internalRouter.post(
  `${BASE}/ai/production-verification`,
  async (req, res, next) => {
    try {
      const workspaceId =
        typeof req.body?.workspaceId === "string"
          ? req.body.workspaceId.trim()
          : "";
      if (!workspaceId || workspaceId.length > 128) {
        return sendError(
          res,
          400,
          "INVALID_WORKSPACE_ID",
          "A valid verification workspaceId is required",
        );
      }
      const { runProductionAiVerification } = await import(
        "../aiPlatform/productionVerification.service.js"
      );
      const result = await runProductionAiVerification({
        workspaceId,
        requestTraceId: req.id,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

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

// DELETE /api/v1/internal/workspaces was previously a HARD-DELETE-EVERY-WORKSPACE
// endpoint reachable by any user with the `developer` role. It has been
// permanently retired. If you genuinely need to wipe workspaces in a non-prod
// environment, write a CLI script under `scripts/` that connects directly to
// the database — no HTTP surface should be able to do this.
//
// We keep the route registered (as 410 Gone) so any forgotten caller gets a
// clear, loud signal instead of silently 404'ing with no breadcrumb.
internalRouter.delete(`${BASE}/workspaces`, (_req, res) => {
  return sendError(
    res,
    410,
    "ENDPOINT_REMOVED",
    "DELETE /api/v1/internal/workspaces has been removed. Use a CLI script for bulk workspace deletion.",
  );
});

// ── Content Debugger ─────────────────────────────────────────────────────

internalRouter.get(`${BASE}/drafts`, async (req, res, next) => {
  try {
    const { search, status, channel, clientId, kind, limit, cursor } =
      req.query;
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
internalRouter.post(
  `${BASE}/services`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = CreateExternalServiceSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const svc = await extService.createService(parsed.data);
      await writeAudit(req, {
        action: "service.create",
        resourceType: "ExternalService",
        resourceId: svc.id,
        metadata: { key: svc.key, category: svc.category },
      });
      res.status(201).json(svc);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.patch(
  `${BASE}/services/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = UpdateExternalServiceSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const svc = await extService.updateService(req.params.id, parsed.data);
      if (!svc) return sendError(res, 404, "NOT_FOUND", "Service not found");
      await writeAudit(req, {
        action: "service.update",
        resourceType: "ExternalService",
        resourceId: svc.id,
        metadata: { changedKeys: Object.keys(parsed.data) },
      });
      res.json(svc);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.delete(
  `${BASE}/services/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await extService.deleteService(req.params.id);
      await writeAudit(req, {
        action: "service.delete",
        resourceType: "ExternalService",
        resourceId: req.params.id,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// Usage snapshot
internalRouter.post(
  `${BASE}/services/:id/usage`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = ExternalServiceUsageSnapshotSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const snapshot = await extService.addUsageSnapshot(
        req.params.id,
        parsed.data,
      );
      res.status(201).json(snapshot);
    } catch (err) {
      next(err);
    }
  },
);

// Refresh auto-derived usage (OpenAI, Fal budget data)
internalRouter.post(
  `${BASE}/services/refresh`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await extService.refreshDerivedUsage();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// Seed initial service records
internalRouter.post(
  `${BASE}/services/seed`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const result = await extService.seedServices();
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

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

internalRouter.post(
  `${BASE}/beta/testers`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = CreateBetaTesterSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const tester = await betaService.createTester(parsed.data);
      await writeAudit(req, {
        action: "tester.create",
        resourceType: "BetaTester",
        resourceId: tester.id,
        metadata: { email: tester.email, cohort: tester.cohort },
      });
      res.status(201).json(tester);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.patch(
  `${BASE}/beta/testers/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = UpdateBetaTesterSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const tester = await betaService.updateTester(req.params.id, parsed.data);
      await writeAudit(req, {
        action: "tester.update",
        resourceType: "BetaTester",
        resourceId: req.params.id,
        metadata: { changedKeys: Object.keys(parsed.data) },
      });
      res.json(tester);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.delete(
  `${BASE}/beta/testers/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await betaService.deleteTester(req.params.id);
      await writeAudit(req, {
        action: "tester.delete",
        resourceType: "BetaTester",
        resourceId: req.params.id,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// Feedback
internalRouter.get(`${BASE}/beta/feedback`, requireAdminRole, async (req, res, next) => {
  try {
    const {
      search,
      status,
      type,
      severity,
      needsFollowUp,
      testerId,
      limit,
      cursor,
    } = req.query;
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

internalRouter.get(`${BASE}/beta/feedback/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const fb = await betaService.getFeedback(req.params.id);
    if (!fb) return sendError(res, 404, "NOT_FOUND", "Feedback not found");
    res.json(fb);
  } catch (err) {
    next(err);
  }
});

// Feedback submission — open to any authenticated internal user
internalRouter.post(`${BASE}/beta/feedback`, requireAdminRole, async (req, res, next) => {
  try {
    const parsed = CreateBetaFeedbackSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const fb = await betaService.createFeedback({
      ...parsed.data,
      // Fallback to the JWT sub if the body didn't supply userId.
      userId: parsed.data.userId || req.auth?.payload?.sub,
    });
    res.status(201).json(fb);
  } catch (err) {
    next(err);
  }
});

// Triage / update feedback — admin only
internalRouter.patch(
  `${BASE}/beta/feedback/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = UpdateBetaFeedbackSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const fb = await betaService.updateFeedback(req.params.id, parsed.data);
      await writeAudit(req, {
        action: "feedback.update",
        resourceType: "BetaFeedback",
        resourceId: req.params.id,
        metadata: {
          changedKeys: Object.keys(parsed.data),
          status: parsed.data.status ?? null,
        },
      });
      res.json(fb);
    } catch (err) {
      next(err);
    }
  },
);

// Product feedback inbox aliases. These intentionally require the stricter
// admin role even though the surrounding internal console permits developers.
internalRouter.get(`${BASE}/feedback`, requireAdminRole, async (req, res, next) => {
  try {
    const result = await betaService.listFeedback({ ...req.query, severity: req.query.priority || undefined, limit: req.query.limit ? parseInt(req.query.limit, 10) : 50 });
    res.json(result);
  } catch (error) { next(error); }
});

internalRouter.get(`${BASE}/feedback/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const feedback = await betaService.getFeedback(req.params.id);
    if (!feedback) return sendError(res, 404, "NOT_FOUND", "Feedback not found");
    res.json(feedback);
  } catch (error) { next(error); }
});

internalRouter.patch(`${BASE}/feedback/:id`, requireAdminRole, async (req, res, next) => {
  try {
    const parsed = UpdateFeedbackSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const feedback = await updateAdminFeedback(req.params.id, parsed.data, req.user.id);
    await writeAudit(req, { action: "feedback.update", resourceType: "BetaFeedback", resourceId: req.params.id, metadata: { changedKeys: Object.keys(parsed.data) } });
    res.json(feedback);
  } catch (error) { next(error); }
});

internalRouter.delete(
  `${BASE}/beta/feedback/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await betaService.deleteFeedback(req.params.id);
      await writeAudit(req, {
        action: "feedback.delete",
        resourceType: "BetaFeedback",
        resourceId: req.params.id,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

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
    const detail = await jobsService.getJobDetail(
      req.params.queue,
      req.params.jobId,
    );
    if (!detail) return sendError(res, 404, "NOT_FOUND", "Job not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

internalRouter.post(
  `${BASE}/jobs/:queue/:jobId/retry`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const result = await jobsService.retryJob(
        req.params.queue,
        req.params.jobId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.delete(
  `${BASE}/jobs/:queue/:jobId`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const result = await jobsService.removeJob(
        req.params.queue,
        req.params.jobId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

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
    if (!detail)
      return sendError(res, 404, "NOT_FOUND", "Webhook endpoint not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

internalRouter.patch(
  `${BASE}/webhooks/endpoints/:id/toggle`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = ToggleWebhookEndpointSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await webhooksService.toggleEndpoint(
        req.params.id,
        parsed.data.isActive,
      );
      await writeAudit(req, {
        action: "webhook.toggle",
        resourceType: "OutboundWebhook",
        resourceId: req.params.id,
        metadata: { isActive: parsed.data.isActive },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

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

internalRouter.get(
  `${BASE}/webhooks/deliveries/:id`,
  async (req, res, next) => {
    try {
      const detail = await webhooksService.getDeliveryDetail(req.params.id);
      if (!detail)
        return sendError(res, 404, "NOT_FOUND", "Delivery not found");
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.post(
  `${BASE}/webhooks/deliveries/:id/replay`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const result = await webhooksService.replayDelivery(req.params.id);
      await writeAudit(req, {
        action: "webhook.replay",
        resourceType: "WebhookDeliveryLog",
        resourceId: req.params.id,
        metadata: { eventType: result?.eventType ?? null },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── System Health ───────────────────────────────────────────────────────

internalRouter.get(`${BASE}/system-health/summary`, async (req, res, next) => {
  try {
    const summary = await systemHealthService.getSystemHealthSummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

internalRouter.get(
  `${BASE}/system-health/ai-operations`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const flagEnabled =
        env.AI_OPERATIONS_CENTER_ENABLED ||
        (await configService.evaluateFlag("ai_operations_center_enabled", {
          userId: req.auth?.payload?.sub || null,
          workspaceId: req.query.workspaceId || undefined,
        }));
      if (!flagEnabled)
        return sendError(
          res,
          404,
          "FEATURE_DISABLED",
          "AI operations center is disabled",
        );
      const since = req.query.since
        ? new Date(String(req.query.since))
        : undefined;
      const summary = await aiObservabilityService.getAiOperationsCenter({
        workspaceId: req.query.workspaceId || undefined,
        taskType: req.query.taskType || undefined,
        provider: req.query.provider || undefined,
        model: req.query.model || undefined,
        promptVersion: req.query.promptVersion || undefined,
        releaseGateStage: req.query.releaseGateStage || undefined,
        since,
      });
      res.json(summary);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.get(
  `${BASE}/system-health/ai-operations/traces/:traceId`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const flagEnabled =
        env.AI_OPERATIONS_CENTER_ENABLED ||
        (await configService.evaluateFlag("ai_operations_center_enabled", {
          userId: req.auth?.payload?.sub || null,
          workspaceId: req.query.workspaceId || undefined,
        }));
      if (!flagEnabled)
        return sendError(
          res,
          404,
          "FEATURE_DISABLED",
          "AI operations center is disabled",
        );
      const trace = await aiObservabilityService.getAiTraceDrilldown({
        traceId: req.params.traceId,
        workspaceId: req.query.workspaceId || undefined,
        actorRoles: req.roles || [],
      });
      if (!trace) return sendError(res, 404, "NOT_FOUND", "Trace not found");
      res.json(trace);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.post(
  `${BASE}/system-health/ai-experiments/report`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const definition = req.body?.definition;
      const workspaceId =
        definition?.workspaceId || req.query.workspaceId || undefined;
      const flagEnabled =
        env.AI_EXPERIMENTATION_ENABLED ||
        (await configService.evaluateFlag("ai_experimentation_enabled", {
          userId: req.auth?.payload?.sub || null,
          workspaceId,
        }));
      if (!flagEnabled)
        return sendError(
          res,
          404,
          "FEATURE_DISABLED",
          "AI experimentation reports are disabled",
        );
      const report = await aiExperimentationService.getExperimentReport({
        actor: {
          auth0Sub: req.auth?.payload?.sub || req.user?.sub || "internal-admin",
        },
        definition,
        exposures: req.body?.exposures || [],
        outcomes: req.body?.outcomes || [],
        featureEnabled: true,
        traceId: req.id,
        authorizationService: async () => ({ allowed: true }),
      });
      const { provenance, ...body } = report;
      setAiProvenanceHeaders(res, provenance);
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

// ── Config / Feature Flags ──────────────────────────────────────────────

internalRouter.get(`${BASE}/config/flags`, async (req, res, next) => {
  try {
    const { category, enabled, search, limit } = req.query;
    const items = await configService.listFlags({
      category: category || undefined,
      enabled:
        enabled === "true" ? true : enabled === "false" ? false : undefined,
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

internalRouter.post(
  `${BASE}/config/flags`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = CreateFeatureFlagSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const adminId = req.auth?.payload?.sub || null;
      const flag = await configService.createFlag(parsed.data, adminId);
      await writeAudit(req, {
        action: "flag.create",
        resourceType: "FeatureFlag",
        resourceId: flag.id,
        metadata: { key: flag.key, enabled: flag.enabled, scope: flag.scope },
      });
      res.status(201).json(flag);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.patch(
  `${BASE}/config/flags/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = UpdateFeatureFlagSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const adminId = req.auth?.payload?.sub || null;
      const flag = await configService.updateFlag(
        req.params.id,
        parsed.data,
        adminId,
      );
      await writeAudit(req, {
        action: "flag.update",
        resourceType: "FeatureFlag",
        resourceId: req.params.id,
        metadata: { changedKeys: Object.keys(parsed.data) },
      });
      res.json(flag);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.patch(
  `${BASE}/config/flags/:id/toggle`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const parsed = ToggleFeatureFlagSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const adminId = req.auth?.payload?.sub || null;
      const flag = await configService.toggleFlag(
        req.params.id,
        parsed.data.enabled,
        adminId,
      );
      await writeAudit(req, {
        action: "flag.toggle",
        resourceType: "FeatureFlag",
        resourceId: req.params.id,
        metadata: { enabled: parsed.data.enabled },
      });
      res.json(flag);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.delete(
  `${BASE}/config/flags/:id`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await configService.deleteFlag(req.params.id);
      await writeAudit(req, {
        action: "flag.delete",
        resourceType: "FeatureFlag",
        resourceId: req.params.id,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.post(
  `${BASE}/config/flags/seed`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const result = await configService.seedFlags();
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

internalRouter.get(
  `${BASE}/config/flags/evaluate/:key`,
  async (req, res, next) => {
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
  },
);

// ── Manual social-metrics sync (admin/developer only) ────────────────────
//
// Lets admins/devs trigger the live metrics sync pipeline against a single
// published draft to debug provider feedback before production. Bypasses
// the 1h cooldown when `force: true` is set.
//
// Response is deliberately debug-safe — never includes access tokens,
// refresh tokens, provider auth headers, or full raw provider payloads.
// All structured failure reasons line up 1:1 with the public sync route's
// reason taxonomy (see SOCIAL_METRICS_FEEDBACK_LOOP.md § 3).
internalRouter.post(
  `${BASE}/drafts/:draftId/metrics/sync`,
  async (req, res, next) => {
    const startedAt = Date.now();
    const { draftId } = req.params;
    const force = req.body?.force === true;

    try {
      const draft = await prisma.draft.findUnique({
        where: { id: draftId },
        select: {
          id: true,
          clientId: true,
          channel: true,
          status: true,
          externalPostId: true,
        },
      });
      if (!draft) {
        return sendError(res, 404, "DRAFT_NOT_FOUND", "Draft not found");
      }

      // Pre-conditions surface as 422 (the draft exists but the operation
      // can't proceed in its current state) — distinct from the
      // service-level reason strings the sync may return for the same
      // conditions, because the service is also called from background
      // jobs that don't want to throw on these.
      if (draft.status !== "PUBLISHED") {
        return sendError(
          res,
          422,
          "NOT_PUBLISHED",
          `Draft is in status ${draft.status}; only PUBLISHED drafts can sync metrics.`,
        );
      }
      if (!draft.externalPostId) {
        return res.status(200).json({
          ok: false,
          draftId: draft.id,
          clientId: draft.clientId,
          channel: draft.channel,
          externalPostId: null,
          status: "skipped",
          reason: "no_external_id",
          detail: "Draft has no provider post id — cannot sync.",
          rawMetricId: null,
          normalizedMetricId: null,
          postMetricsUpdated: false,
          lastSyncedAt: null,
          forceUsed: force,
          durationMs: Date.now() - startedAt,
        });
      }

      let result;
      try {
        result = await syncMetricsForDraft(draft.id, { force });
      } catch (err) {
        // Service re-throws unclassified errors — surface as a clean
        // failure with safe detail (no stack, no token).
        result = {
          synced: false,
          reason: "internal_error",
          detail: err?.code ?? err?.message ?? "Unknown error",
        };
      }

      const durationMs = Date.now() - startedAt;
      const payload = result.synced
        ? {
            ok: true,
            draftId: draft.id,
            clientId: draft.clientId,
            channel: draft.channel,
            externalPostId: draft.externalPostId,
            status: "synced",
            reason: null,
            detail: null,
            rawMetricId: result.rawMetricId ?? null,
            normalizedMetricId: result.normalizedMetricId ?? null,
            postMetricsUpdated: true,
            lastSyncedAt: result.fetchedAt ?? null,
            forceUsed: force,
            durationMs,
          }
        : {
            ok: false,
            draftId: draft.id,
            clientId: draft.clientId,
            channel: draft.channel,
            externalPostId: draft.externalPostId,
            // skipped = service intentionally short-circuited (cooldown,
            // missing prereq); failed = adapter or pipeline error.
            status: classifySkipOrFail(result.reason),
            reason: result.reason ?? "unknown",
            detail: sanitizeDetail(result.detail) ?? null,
            rawMetricId: null,
            normalizedMetricId: null,
            postMetricsUpdated: false,
            lastSyncedAt: null,
            forceUsed: force,
            durationMs,
          };

      logEvent("metrics.manual_sync", {
        actorSub: req.auth?.payload?.sub ?? null,
        actorRoles: req.roles ?? [],
        draftId: draft.id,
        clientId: draft.clientId,
        channel: draft.channel,
        force,
        status: payload.status,
        reason: payload.reason,
        durationMs,
      });

      res.json(payload);
    } catch (err) {
      next(err);
    }
  },
);

// "skipped" = service short-circuited before hitting the provider.
// "failed"  = provider/adapter/pipeline error. Both surface to the UI
// with the same row layout but distinguish what action the operator
// should take next.
function classifySkipOrFail(reason) {
  const skip = new Set([
    "draft_not_found",
    "not_published",
    "no_external_id",
    "too_recent",
    "no_connection",
    "unsupported_channel",
  ]);
  return skip.has(reason) ? "skipped" : "failed";
}

// Defense-in-depth scrub for `detail` strings before they're emitted
// over the wire. The service's contract is "no tokens in result" — but
// since adapters concatenate provider error messages into detail, a
// future regression could slip a Bearer header through. Strip any
// substring that looks like a bearer-style auth token before serializing.
function sanitizeDetail(s) {
  if (typeof s !== "string" || s.length === 0) return s ?? null;
  // Mask "Bearer <anything-not-whitespace>"
  let out = s.replace(/Bearer\s+\S+/gi, "Bearer ***");
  // Cap length to keep debug output reasonable.
  if (out.length > 500) out = out.slice(0, 497) + "...";
  return out;
}
