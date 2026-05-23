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
  GeneratePageSchema,
} from "./sites.schemas.js";
import * as service from "./sites.dashboard.service.js";
import { generatePageFromSource, translatePage } from "./sites.generation.service.js";
import {
  getServiceStatus,
  isProviderBudgetExceeded,
} from "../billing/serviceHealth.service.js";

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

// ── Page generation ─────────────────────────────────────────────────────
//
// Two endpoints share the same generation pipeline:
//   POST /generate      — preview only, returns the payload
//                          without persisting. Useful for the
//                          wizard's "regenerate" loop.
//   POST /from-source   — generates + creates the LeadForm +
//                          creates the SitePage as DRAFT, then
//                          returns the new page so the dashboard
//                          can route the user into the editor.
//
// Both pre-flight the OpenAI provider health + budget so the
// dashboard can show a friendly 503 instead of waiting for the
// LLM call to time out.

async function preflightOpenAi(res) {
  const status = await getServiceStatus("openai");
  if (status === "down") {
    sendError(res, 503, "SERVICE_UNAVAILABLE", "AI service is temporarily unavailable");
    return false;
  }
  const overBudget = await isProviderBudgetExceeded("openai");
  if (overBudget) {
    sendError(res, 503, "BUDGET_EXCEEDED", "Monthly AI budget exhausted");
    return false;
  }
  return true;
}

sitesDashboardRouter.post(
  `${BASE}/workspaces/:id/site/pages/generate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GeneratePageSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      if (!(await preflightOpenAi(res))) return;
      const result = await generatePageFromSource({
        clientId: req.params.id,
        userId: getAuth0Sub(req),
        ...parsed.data,
      });
      res.json(result);
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

sitesDashboardRouter.post(
  `${BASE}/workspaces/:id/site/pages/from-source`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GeneratePageSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      if (!(await preflightOpenAi(res))) return;

      const generation = await generatePageFromSource({
        clientId: req.params.id,
        userId: getAuth0Sub(req),
        ...parsed.data,
      });

      // Auto-create a LeadForm from the suggested fields so the
      // lead_form block in the generated page resolves to a real
      // form id. We name it after the page so the dashboard form
      // list stays scannable.
      const usesLeadForm = generation.payload.blocksJson.some(
        (b) => b.type === "lead_form",
      );
      let formId = null;
      if (usesLeadForm && generation.suggestedFormFields.length > 0) {
        const form = await service.createForm(
          req.params.id,
          getAuth0Sub(req),
          {
            name: `${generation.payload.title} — Contact form`,
            fieldsJson: generation.suggestedFormFields,
            successAction: {
              type: "message",
              message: generation.formSuccessMessage,
            },
            notifyEmail: null,
          },
        );
        formId = form.id;
      }

      // Resolve the __PENDING__ placeholder in the lead_form block
      // to the real formId (or drop the block if form creation
      // didn't happen, e.g. for LISTING pages with no lead form).
      const blocksJson = [];
      for (const block of generation.payload.blocksJson) {
        if (block.type === "lead_form") {
          if (formId) blocksJson.push({ type: "lead_form", formId });
          // Skip if no form — the lead_form block was a
          // suggestion the user can wire up manually later.
          continue;
        }
        blocksJson.push(block);
      }

      // Use a unique-suffix retry loop on slug collision so the
      // wizard never fails on the create step. The user can rename
      // the slug freely in the editor afterwards.
      let attempt = 0;
      let page = null;
      let slug = generation.payload.slug;
      while (attempt < 5 && !page) {
        try {
          page = await service.createPage(req.params.id, getAuth0Sub(req), {
            ...generation.payload,
            slug,
            blocksJson,
            sourceType: generation.sourceContext.sourceType,
            sourceId: generation.sourceContext.sourceId,
            pageGoal: parsed.data.pageGoal,
          });
        } catch (err) {
          if (err?.code === "SLUG_TAKEN" && attempt < 4) {
            attempt += 1;
            slug = `${generation.payload.slug}-${attempt + 1}`.slice(0, 128);
            continue;
          }
          throw err;
        }
      }
      if (!page) {
        return sendError(
          res,
          409,
          "SLUG_TAKEN",
          "Couldn't find an available slug — try again or pick one manually",
        );
      }

      res.status(201).json({ page, generation: { model: generation.model } });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Page translation (Phase 2 multilingual) ─────────────────────────────
//
// POST /api/v1/workspaces/:id/site/pages/:pageId/translate
//
// Creates a sibling SitePage in the target language. Idempotent —
// a duplicate request returns the existing sibling rather than
// burning another LLM call. The compound unique
// `(clientId, slug, language)` lets both rows keep the same clean
// slug; the public URL prefix `/es/<slug>` is added at render time.
sitesDashboardRouter.post(
  `${BASE}/workspaces/:id/site/pages/:pageId/translate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const targetLanguage =
        typeof req.body?.to === "string" ? req.body.to : null;
      if (!targetLanguage) {
        return validationError(res, [
          { path: ["to"], message: "Target language is required (e.g. 'es')" },
        ]);
      }
      if (!(await preflightOpenAi(res))) return;

      const result = await translatePage({
        clientId: req.params.id,
        pageId: req.params.pageId,
        targetLanguage,
        userId: getAuth0Sub(req),
      });
      // Returns the source page (now linked) and the translated row.
      // `existing` lets the FE distinguish "freshly created" vs
      // "already had one" for a different toast/copy.
      res.status(result.existing ? 200 : 201).json({
        existing: result.existing,
        source: result.source,
        translated: result.translated,
      });
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
