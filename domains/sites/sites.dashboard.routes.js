// Authenticated dashboard router for SquadSites.
//
// Mounted AFTER the global /api auth middleware (server.js), so
// every handler runs with a valid JWT. Each workspace-scoped route
// uses requireClientOwner to verify the caller owns the workspace
// referenced by :clientId.
//
// All routes return JSON with consistent shape:
//   200/201 → { site } | { pages } | { page } | { forms } | etc.
//   4xx     → { error: "CODE", message: "Human readable" }

import express from "express";
import { getAuth0Sub } from "../../middleware/auth.js";
import { requireClientOwner } from "../studio/ownership.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
import {
  UpdateSiteSchema,
  CreatePageSchema,
  UpdatePageSchema,
  CreateFormSchema,
  UpdateFormSchema,
  UpdateSubmissionSchema,
  ListSubmissionsQuerySchema,
} from "./sites.schemas.js";
import * as service from "./sites.dashboard.service.js";

export const sitesDashboardRouter = express.Router();

const BASE = "/api/v1";

// Shared error → response shaper for typed service errors
// (err.status + err.code) so route bodies stay short.
function handleServiceError(res, err, next) {
  if (err && typeof err.status === "number") {
    return sendError(res, err.status, err.code || "REQUEST_FAILED", err.message || "Request failed");
  }
  return next(err);
}

// ── Site (one per workspace) ────────────────────────────────────────────

sitesDashboardRouter.get(
  `${BASE}/workspaces/:id/site`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const site = await service.getOrCreateSite(req.params.id, getAuth0Sub(req));
      res.json({ site });
    } catch (err) {
      next(err);
    }
  },
);

sitesDashboardRouter.patch(
  `${BASE}/workspaces/:id/site`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdateSiteSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const site = await service.updateSite(req.params.id, {
        ...parsed.data,
        createdBy: getAuth0Sub(req),
      });
      res.json({ site });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Pages ───────────────────────────────────────────────────────────────

sitesDashboardRouter.get(
  `${BASE}/workspaces/:id/site/pages`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const pages = await service.listPages(req.params.id);
      res.json({ pages });
    } catch (err) {
      next(err);
    }
  },
);

sitesDashboardRouter.post(
  `${BASE}/workspaces/:id/site/pages`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = CreatePageSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const page = await service.createPage(
        req.params.id,
        getAuth0Sub(req),
        parsed.data,
      );
      res.status(201).json({ page });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

sitesDashboardRouter.get(
  `${BASE}/workspaces/:id/site/pages/:pageId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const page = await service.getPage(req.params.id, req.params.pageId);
      if (!page) return sendError(res, 404, "PAGE_NOT_FOUND", "Page not found");
      res.json({ page });
    } catch (err) {
      next(err);
    }
  },
);

sitesDashboardRouter.patch(
  `${BASE}/workspaces/:id/site/pages/:pageId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdatePageSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const page = await service.updatePage(
        req.params.id,
        req.params.pageId,
        parsed.data,
      );
      res.json({ page });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

sitesDashboardRouter.post(
  `${BASE}/workspaces/:id/site/pages/:pageId/publish`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const page = await service.publishPage(req.params.id, req.params.pageId);
      res.json({ page });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

sitesDashboardRouter.post(
  `${BASE}/workspaces/:id/site/pages/:pageId/unpublish`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const page = await service.unpublishPage(req.params.id, req.params.pageId);
      res.json({ page });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

sitesDashboardRouter.delete(
  `${BASE}/workspaces/:id/site/pages/:pageId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await service.deletePage(req.params.id, req.params.pageId);
      res.json(result);
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Forms ───────────────────────────────────────────────────────────────

sitesDashboardRouter.get(
  `${BASE}/workspaces/:id/site/forms`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const forms = await service.listForms(req.params.id);
      res.json({ forms });
    } catch (err) {
      next(err);
    }
  },
);

sitesDashboardRouter.post(
  `${BASE}/workspaces/:id/site/forms`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = CreateFormSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const form = await service.createForm(
        req.params.id,
        getAuth0Sub(req),
        parsed.data,
      );
      res.status(201).json({ form });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

sitesDashboardRouter.get(
  `${BASE}/workspaces/:id/site/forms/:formId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const form = await service.getForm(req.params.id, req.params.formId);
      if (!form) return sendError(res, 404, "FORM_NOT_FOUND", "Form not found");
      res.json({ form });
    } catch (err) {
      next(err);
    }
  },
);

sitesDashboardRouter.patch(
  `${BASE}/workspaces/:id/site/forms/:formId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdateFormSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const form = await service.updateForm(
        req.params.id,
        req.params.formId,
        parsed.data,
      );
      res.json({ form });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

sitesDashboardRouter.delete(
  `${BASE}/workspaces/:id/site/forms/:formId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await service.deleteForm(req.params.id, req.params.formId);
      res.json(result);
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Submissions ─────────────────────────────────────────────────────────

sitesDashboardRouter.get(
  `${BASE}/workspaces/:id/site/submissions`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListSubmissionsQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await service.listSubmissions(req.params.id, parsed.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

sitesDashboardRouter.patch(
  `${BASE}/workspaces/:id/site/submissions/:submissionId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdateSubmissionSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const submission = await service.updateSubmissionStatus(
        req.params.id,
        req.params.submissionId,
        parsed.data.status,
      );
      res.json({ submission });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);
