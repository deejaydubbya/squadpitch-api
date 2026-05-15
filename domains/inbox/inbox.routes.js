// Authenticated SquadInbox API routes.
//
// Mounted after the global /api auth middleware so every handler
// runs with a verified JWT. Each workspace-scoped route runs
// requireClientOwner against :id to verify the caller owns the
// referenced workspace.

import express from "express";
import { getAuth0Sub } from "../../middleware/auth.js";
import { requireClientOwner } from "../studio/ownership.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
import {
  getServiceStatus,
  isProviderBudgetExceeded,
} from "../billing/serviceHealth.service.js";
import {
  ListConversationsQuerySchema,
  UpdateConversationSchema,
  CreateNoteSchema,
  ManualMessageSchema,
  AiReplyRequestSchema,
  SendEmailSchema,
} from "./inbox.schemas.js";
import * as service from "./inbox.service.js";
import { sendInboxEmail } from "./inbox.outbound.email.service.js";

export const inboxRouter = express.Router();

const BASE = "/api/v1";

function handleServiceError(res, err, next) {
  if (err && typeof err.status === "number") {
    return sendError(
      res,
      err.status,
      err.code || "REQUEST_FAILED",
      err.message || "Request failed",
    );
  }
  return next(err);
}

// ── Conversations ──────────────────────────────────────────────────────

inboxRouter.get(
  `${BASE}/workspaces/:id/inbox/conversations`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListConversationsQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await service.listConversations(req.params.id, parsed.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

inboxRouter.get(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const conversation = await service.getConversation(
        req.params.id,
        req.params.conversationId,
      );
      if (!conversation) {
        return sendError(res, 404, "CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      res.json({ conversation });
    } catch (err) {
      next(err);
    }
  },
);

inboxRouter.patch(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdateConversationSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const conversation = await service.updateConversation(
        req.params.id,
        req.params.conversationId,
        parsed.data,
      );
      res.json({ conversation });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Notes ──────────────────────────────────────────────────────────────

inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId/notes`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = CreateNoteSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const note = await service.createNote(
        req.params.id,
        req.params.conversationId,
        getAuth0Sub(req),
        parsed.data.body,
      );
      res.status(201).json({ note });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Manual outbound log ────────────────────────────────────────────────

inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId/messages/manual`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ManualMessageSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const message = await service.logManualMessage(
        req.params.id,
        req.params.conversationId,
        getAuth0Sub(req),
        parsed.data,
      );
      res.status(201).json({ message });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Send email (real outbound — capability-gated) ──────────────────────
//
// First real send channel. Capability check + Postmark call live in
// inbox.outbound.email.service.js; this route is just the auth +
// validation seam. AI suggestions never auto-send — the user must
// click this endpoint explicitly.
inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId/send-email`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = SendEmailSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const message = await sendInboxEmail(
        req.params.id,
        req.params.conversationId,
        getAuth0Sub(req),
        parsed.data,
      );
      res.status(201).json({ message });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── AI reply suggestion ────────────────────────────────────────────────

inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId/ai-reply`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = AiReplyRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Pre-flight OpenAI health + budget so we don't make the
      // user wait ~30s for a timed-out call when we already know
      // the upstream is unavailable.
      const status = await getServiceStatus("openai");
      if (status === "down") {
        return sendError(
          res,
          503,
          "SERVICE_UNAVAILABLE",
          "AI service is temporarily unavailable",
        );
      }
      const overBudget = await isProviderBudgetExceeded("openai");
      if (overBudget) {
        return sendError(
          res,
          503,
          "BUDGET_EXCEEDED",
          "Monthly AI budget exhausted",
        );
      }

      const suggestion = await service.generateAiReply(
        req.params.id,
        req.params.conversationId,
        getAuth0Sub(req),
        parsed.data,
      );
      res.status(201).json({ suggestion });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Dashboard stats ────────────────────────────────────────────────────

inboxRouter.get(
  `${BASE}/workspaces/:id/inbox/stats`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const stats = await service.getInboxStats(req.params.id);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  },
);
