import express from "express";
import { sendError } from "../../lib/apiErrors.js";
import {
  runPostmarkSyntheticCanary,
  verifyPostmarkSyntheticCanary,
} from "./postmarkCanary.service.js";

export const postmarkCanaryRouter = express.Router();

postmarkCanaryRouter.post(
  "/api/v1/internal/canary/postmark/send",
  express.json({ limit: "16kb" }),
  async (req, res, next) => {
    try {
      const authorization = String(req.get("authorization") ?? "");
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      const result = await runPostmarkSyntheticCanary({
        token,
        input: req.body,
      });
      return res.status(201).json(result);
    } catch (error) {
      if (typeof error?.status === "number") {
        return sendError(
          res,
          error.status,
          error.code ?? "POSTMARK_CANARY_FAILED",
          error.message,
        );
      }
      return next(error);
    }
  },
);

postmarkCanaryRouter.post(
  "/api/v1/internal/canary/postmark/verify",
  express.json({ limit: "8kb" }),
  async (req, res, next) => {
    try {
      const authorization = String(req.get("authorization") ?? "");
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      return res.json(
        await verifyPostmarkSyntheticCanary({ token, input: req.body }),
      );
    } catch (error) {
      if (typeof error?.status === "number") {
        return sendError(
          res,
          error.status,
          error.code ?? "POSTMARK_CANARY_FAILED",
          error.message,
        );
      }
      return next(error);
    }
  },
);
