import { Router } from "express";
import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";
import { sendError } from "../../lib/apiErrors.js";
import { requireClientOwner } from "../studio/ownership.js";
import { validateCanaryInvocation } from "./canaryPolicy.js";
import { runProductionCanary } from "./canary.service.js";

export const canaryRouter = Router();

canaryRouter.post(
  "/api/v1/workspaces/:id/production-canary",
  requireClientOwner,
  async (req, res, next) => {
    try {
      const workspace = await prisma.client.findUnique({
        where: { id: req.params.id },
        select: { name: true },
      });
      const errors = validateCanaryInvocation({
        configuredWorkspaceId: env.PRODUCTION_CANARY_WORKSPACE_ID,
        requestedWorkspaceId: req.params.id,
        workspaceName: workspace?.name,
        synthetic: req.body?.synthetic,
        runId: req.body?.runId,
      });
      if (errors.length) {
        return sendError(res, 403, "CANARY_NOT_ALLOWED", errors[0]);
      }
      const report = await runProductionCanary({
        workspaceId: req.params.id,
        userId: req.user.id,
        runId: req.body.runId,
        requestId: req.id,
      });
      res.status(report.summary.fail ? 503 : 200).json(report);
    } catch (error) {
      next(error);
    }
  },
);
