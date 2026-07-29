import express from "express";
import { getAuth0Sub } from "../../middleware/auth.js";
import { sendError } from "../../lib/apiErrors.js";
import { writeAudit } from "../../lib/auditLog.js";
import { requestAccountLifecycle } from "./accountLifecycle.service.js";

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
        },
        immediateEffects: {
          workspacesArchived: true,
          automationStopped: true,
          storedWorkspaceConnectionsRemoved: true,
        },
        manualCompletionRequired: true,
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
        manualCompletionRequired: true,
      });
    } catch (err) {
      next(err);
    }
  },
);
