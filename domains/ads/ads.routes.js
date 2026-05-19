// Authenticated SquadAds API routes.
//
// Mounted after the global /api auth middleware so every handler
// runs with a verified JWT. requireClientOwner on every route
// pre-verifies the caller owns the referenced workspace.
//
// MVP is export-only — no route in here calls any external ad
// platform. The /export endpoint generates a downloadable artifact
// and the caller streams it; nothing leaves the workspace.

import express from "express";
import { getAuth0Sub } from "../../middleware/auth.js";
import { requireClientOwner } from "../studio/ownership.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
import {
  getServiceStatus,
  isProviderBudgetExceeded,
} from "../billing/serviceHealth.service.js";
import {
  ListPackagesQuerySchema,
  CreatePackageSchema,
  UpdatePackageSchema,
  GenerateRequestSchema,
  UpsertCreativeSchema,
  AudiencePatchSchema,
  BudgetPatchSchema,
  DestinationPatchSchema,
  ExportRequestSchema,
} from "./ads.schemas.js";
import * as service from "./ads.service.js";
import { exportPackage, ExportError } from "./ads.export.service.js";

export const adsRouter = express.Router();

const BASE = "/api/v1";

function handleServiceError(res, err, next) {
  if (err && typeof err.status === "number") {
    return sendError(res, err.status, err.code || "REQUEST_FAILED", err.message || "Request failed");
  }
  return next(err);
}

// ── List + detail ──────────────────────────────────────────────────────

adsRouter.get(`${BASE}/workspaces/:id/ads`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = ListPackagesQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const result = await service.listPackages(req.params.id, parsed.data);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

adsRouter.get(`${BASE}/workspaces/:id/ads/stats`, requireClientOwner, async (req, res, next) => {
  try {
    const stats = await service.getAdsStats(req.params.id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

adsRouter.get(`${BASE}/workspaces/:id/ads/:packageId`, requireClientOwner, async (req, res, next) => {
  try {
    const pkg = await service.getPackage(req.params.id, req.params.packageId);
    if (!pkg) return sendError(res, 404, "AD_PACKAGE_NOT_FOUND", "Ad package not found");
    res.json({ package: pkg });
  } catch (err) {
    next(err);
  }
});

// ── Create ─────────────────────────────────────────────────────────────

adsRouter.post(`${BASE}/workspaces/:id/ads`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = CreatePackageSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const userId = getAuth0Sub(req);
    const pkg = await service.createPackage(req.params.id, userId, parsed.data);
    res.status(201).json({ package: pkg });
  } catch (err) {
    handleServiceError(res, err, next);
  }
});

// ── Update ─────────────────────────────────────────────────────────────

adsRouter.patch(
  `${BASE}/workspaces/:id/ads/:packageId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdatePackageSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const userId = getAuth0Sub(req);
      const pkg = await service.updatePackage(req.params.id, req.params.packageId, userId, parsed.data);
      res.json({ package: pkg });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Generate ───────────────────────────────────────────────────────────

adsRouter.post(
  `${BASE}/workspaces/:id/ads/:packageId/generate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GenerateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Pre-flight OpenAI health + budget so the user doesn't wait
      // ~45s for a doomed call when we already know upstream is down.
      const status = await getServiceStatus("openai");
      if (status === "down") {
        return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI service is temporarily unavailable");
      }
      const overBudget = await isProviderBudgetExceeded("openai");
      if (overBudget) {
        return sendError(res, 503, "BUDGET_EXCEEDED", "Monthly AI budget exhausted");
      }

      const pkg = await service.generatePackage(
        req.params.id,
        req.params.packageId,
        getAuth0Sub(req),
        parsed.data,
      );
      res.status(200).json({ package: pkg });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Children CRUD (creative, audience, budget, destination) ────────────

adsRouter.put(
  `${BASE}/workspaces/:id/ads/:packageId/creatives/:variantIndex`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const variantIndex = Number(req.params.variantIndex);
      if (!Number.isInteger(variantIndex) || variantIndex < 1 || variantIndex > 20) {
        return sendError(res, 400, "BAD_REQUEST", "variantIndex must be an integer 1-20");
      }
      const parsed = UpsertCreativeSchema.safeParse({ ...req.body, variantIndex });
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const creative = await service.upsertCreative(req.params.id, req.params.packageId, parsed.data);
      res.status(200).json({ creative });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

adsRouter.delete(
  `${BASE}/workspaces/:id/ads/:packageId/creatives/:creativeId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      await service.deleteCreative(req.params.id, req.params.packageId, req.params.creativeId);
      res.status(204).end();
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

adsRouter.patch(
  `${BASE}/workspaces/:id/ads/:packageId/audience`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = AudiencePatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const audience = await service.upsertAudience(req.params.id, req.params.packageId, parsed.data);
      res.json({ audience });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

adsRouter.patch(
  `${BASE}/workspaces/:id/ads/:packageId/budget`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = BudgetPatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const budget = await service.upsertBudget(req.params.id, req.params.packageId, parsed.data);
      res.json({ budget });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

adsRouter.patch(
  `${BASE}/workspaces/:id/ads/:packageId/destination`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = DestinationPatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const destination = await service.upsertDestination(req.params.id, req.params.packageId, parsed.data);
      res.json({ destination });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Export ─────────────────────────────────────────────────────────────
//
// Ads-03 — preview vs download. The body's `mode` field decides
// whether the call mutates the package:
//   - mode: 'preview'  (default) returns the JSON wrapper; never
//     appends export history, never flips READY→EXPORTED.
//   - mode: 'download' returns the JSON wrapper AND marks the
//     package exported. The frontend converts content → Blob using
//     the returned mimeType + filename, so we always respond with
//     the structured wrapper (no Content-Disposition stream).
//
// Legacy compat: callers that pass `?download=1` on the query
// string are mapped to mode='download' so older builds of the web
// app keep working. The query param wins when present — explicit
// download intent shouldn't be silently downgraded.

adsRouter.post(
  `${BASE}/workspaces/:id/ads/:packageId/export`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ExportRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const userId = getAuth0Sub(req);

      const wantsDownloadParam = req.query.download === "1";
      const mode = wantsDownloadParam ? "download" : parsed.data.mode;

      const { filename, mimeType, content, bundle } = await exportPackage(
        req.params.id,
        req.params.packageId,
        userId,
        { format: parsed.data.format, mode },
      );

      // For an explicit ?download=1 request we still stream as an
      // attachment so curl/postman users get the file directly.
      // The in-app UI uses the JSON wrapper + a client-side Blob.
      if (wantsDownloadParam) {
        res.setHeader("Content-Type", mimeType);
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(content);
      }
      res.json({ filename, mimeType, content, bundle, mode });
    } catch (err) {
      if (err instanceof ExportError) {
        return sendError(res, err.status, err.code, err.message);
      }
      handleServiceError(res, err, next);
    }
  },
);
