import express from "express";
import { getAuth0Sub } from "../../middleware/auth.js";
import { sendError } from "../../lib/apiErrors.js";
import { writeAudit } from "../../lib/auditLog.js";
import { cancelDeletion, requestAccountLifecycle } from "./accountLifecycle.service.js";
import { prepareExportDownload } from "./accountExport.service.js";

export const accountLifecycleRouter = express.Router();

accountLifecycleRouter.post(
  "/api/v1/account/deletion-request",
  async (req, res, next) => {
    try {
      if (req.body?.confirmation !== "DELETE MY ACCOUNT") {
        return sendError(
          res,
          400,
          "CONFIRMATION_REQUIRED",
          'Enter "DELETE MY ACCOUNT" to request account deletion.',
        );
      }
      const result = await requestAccountLifecycle({
        user: req.user,
        auth0Sub: getAuth0Sub(req),
        type: "DELETE_ACCOUNT",
      });
      await writeAudit(req, {
        action: "account.deletion_requested",
        resourceType: "AccountLifecycleRequest",
        resourceId: result.request.id,
        metadata: { created: result.created },
      });
      return res.status(result.created ? 202 : 200).json({
        request: {
          id: result.request.id,
          type: result.request.type,
          status: result.request.status,
          requestedAt: result.request.requestedAt,
          graceEndsAt: result.request.graceEndsAt,
        },
        immediateEffects: {
          workspacesArchived: true,
          automationStopped: true,
          storedWorkspaceConnectionsRemoved: true,
        },
        finalPurgeScheduled: true,
        reconnectionRequiredIfCancelled: true,
      });
    } catch (err) {
      next(err);
    }
  },
);

accountLifecycleRouter.post(
  "/api/v1/account/export-request",
  async (req, res, next) => {
    try {
      const result = await requestAccountLifecycle({
        user: req.user,
        auth0Sub: getAuth0Sub(req),
        type: "EXPORT_ACCOUNT",
      });
      await writeAudit(req, {
        action: "account.export_requested",
        resourceType: "AccountLifecycleRequest",
        resourceId: result.request.id,
        metadata: { created: result.created },
      });
      return res.status(result.created ? 202 : 200).json({
        request: {
          id: result.request.id,
          type: result.request.type,
          status: result.request.status,
          requestedAt: result.request.requestedAt,
        },
        downloadUrl: `/api/v1/account/exports/${result.request.id}/download`,
        expiresAfterDownloadDays: 7,
      });
    } catch (err) {
      next(err);
    }
  },
);

accountLifecycleRouter.get("/api/v1/account/exports/:requestId/download", async (req, res, next) => {
  try {
    const result = await prepareExportDownload({ requestId: req.params.requestId, user: req.user });
    res.set({
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="squadpitch-account-export-${result.manifest.generatedAt.slice(0, 10)}.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    return res.status(200).send(result.buffer);
  } catch (error) { next(error); }
});

accountLifecycleRouter.post("/api/v1/account/deletion-request/:requestId/cancel", async (req, res, next) => {
  try {
    if (req.body?.confirmation !== "CANCEL ACCOUNT DELETION") return sendError(res, 400, "CONFIRMATION_REQUIRED", 'Enter "CANCEL ACCOUNT DELETION" to cancel.');
    const request = await cancelDeletion({ requestId: req.params.requestId, user: req.user });
    await writeAudit(req, { action: "account.deletion_cancelled", resourceType: "AccountLifecycleRequest", resourceId: request.id });
    return res.status(200).json({ request: { id: request.id, status: request.status, cancelledAt: request.cancelledAt }, integrationsRequireReconnect: true });
  } catch (error) { next(error); }
});
