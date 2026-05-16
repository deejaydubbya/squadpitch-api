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
import { writeAudit } from "../../lib/auditLog.js";
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
  UpdateContactSchema,
} from "./inbox.schemas.js";
import * as service from "./inbox.service.js";
import { sendInboxEmail } from "./inbox.outbound.email.service.js";
import { sendGbpReviewReply } from "./inbox.outbound.gbp.service.js";
import { sendYouTubeCommentReply } from "./inbox.outbound.youtube.service.js";

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
      // Idempotency key — client supplies via header, generates a
      // fresh UUID per Send click. A retried POST (double-click,
      // network retry, server-restart-during-call) with the same
      // key returns the existing Message instead of firing a
      // duplicate provider send. Falls through to a normal send
      // when missing — older clients still work.
      const idempotencyKey =
        typeof req.headers["idempotency-key"] === "string" && req.headers["idempotency-key"].trim()
          ? req.headers["idempotency-key"].trim().slice(0, 128)
          : null;
      const message = await sendInboxEmail(
        req.params.id,
        req.params.conversationId,
        getAuth0Sub(req),
        { ...parsed.data, idempotencyKey },
      );
      res.status(201).json({ message });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Send GBP public review reply (capability-gated) ────────────────────
//
// Workspace-owner gated; idempotency-key header mirrors the
// email send path. PROVIDER_NOT_AVAILABLE (412) returns when
// the workspace lacks a fully-configured GBP location with
// business.manage scope — the UI surfaces the reason verbatim.
inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId/reply-review`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const body = typeof req.body?.body === "string" ? req.body.body : "";
      if (!body || body.trim().length === 0) {
        return validationError(res, [
          { path: ["body"], message: "body is required" },
        ]);
      }
      // Same idempotency-key pattern as send-email — fresh UUID
      // per click. A retried POST returns the existing Message
      // instead of firing a duplicate public reply.
      const idempotencyKey =
        typeof req.headers["idempotency-key"] === "string" &&
        req.headers["idempotency-key"].trim()
          ? req.headers["idempotency-key"].trim().slice(0, 128)
          : null;
      const message = await sendGbpReviewReply(
        req.params.id,
        req.params.conversationId,
        getAuth0Sub(req),
        { body, idempotencyKey },
      );
      res.status(201).json({ message });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Send YouTube public comment reply (capability-gated) ───────────────
//
// Workspace-owner gated; idempotency-key header mirrors the email
// and GBP send paths. PROVIDER_NOT_AVAILABLE (412) returns when
// the workspace's YouTube connection isn't set up with
// youtube.force-ssl — the UI surfaces the reason verbatim
// ("Reconnect YouTube and grant the comment-reply permission").
//
// The reply lands on YouTube as a public reply under the comment
// — visible to every viewer of the video. Requires explicit user
// click; never auto-sent (the composer button posts here only
// when the user explicitly clicks Send).
inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId/reply-comment`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const body = typeof req.body?.body === "string" ? req.body.body : "";
      if (!body || body.trim().length === 0) {
        return validationError(res, [
          { path: ["body"], message: "body is required" },
        ]);
      }
      const idempotencyKey =
        typeof req.headers["idempotency-key"] === "string" &&
        req.headers["idempotency-key"].trim()
          ? req.headers["idempotency-key"].trim().slice(0, 128)
          : null;

      // Provider-aware dispatch — same composer button maps to a
      // different outbound service per Conversation.provider. Today:
      // YOUTUBE is wired. LINKEDIN stays gated (resolver short-
      // circuits before the user can click); other providers
      // return 412.
      const { prisma } = await import("../../prisma.js");
      const conv = await prisma.conversation.findFirst({
        where: { id: req.params.conversationId, clientId: req.params.id },
        select: { provider: true },
      });
      if (!conv) {
        return sendError(res, 404, "CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      if (conv.provider !== "YOUTUBE") {
        return sendError(
          res,
          412,
          "PROVIDER_NOT_AVAILABLE",
          `Public comment reply isn't connected yet for ${conv.provider}.`,
        );
      }

      const message = await sendYouTubeCommentReply(
        req.params.id,
        req.params.conversationId,
        getAuth0Sub(req),
        { body, idempotencyKey },
      );
      res.status(201).json({ message });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Manual "sync now" trigger for GBP reviews (developer/admin) ────────
//
// Useful for first-sync seeding and for the UI's "Sync reviews
// now" button. Runs the same polling code the cron job runs but
// scoped to one workspace's GBP connection so a slow tick doesn't
// block other workspaces.
inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/_gbp-sync`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { prisma } = await import("../../prisma.js");
      const conn = await prisma.channelConnection.findUnique({
        where: {
          clientId_channel: {
            clientId: req.params.id,
            channel: "GOOGLE_BUSINESS_PROFILE",
          },
        },
      });
      if (!conn) {
        return sendError(
          res,
          404,
          "NO_CONNECTION",
          "Connect a Google Business Profile location first.",
        );
      }
      const { pollGbpReviewsForConnection } = await import(
        "./gbpReviewPoller.service.js"
      );
      const summary = await pollGbpReviewsForConnection(conn);
      res.json(summary);
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

// ── Contact mutation (CRM-lite) ────────────────────────────────────────
//
// Workspace-scoped — requireClientOwner gates on :id, and the
// service layer scopes the contact lookup by clientId in defense
// in depth. Every successful mutation writes an AuditLog row with
// a before/after diff for the keys the caller actually changed.
inboxRouter.patch(
  `${BASE}/workspaces/:id/contacts/:contactId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdateContactSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const { contact, diff } = await service.updateContact(
        req.params.id,
        req.params.contactId,
        parsed.data,
      );
      // Audit only when something actually changed. A no-op PATCH
      // (e.g. setting status to its current value) shouldn't pad
      // the audit table.
      if (Object.keys(diff).length > 0) {
        await writeAudit(req, {
          action: "contact.update",
          resourceType: "Contact",
          resourceId: contact.id,
          metadata: { clientId: req.params.id, diff },
        });
      }
      res.json({ contact });
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

// ── GBP review test injector (workspace-admin only) ────────────────────
//
// Until the real Google Business Profile OAuth + reviews-polling
// adapter ships, this route lets a workspace owner inject a
// synthetic review payload to exercise the ingestion service
// end-to-end. Same shape the future polling worker will hand
// ingestGbpReview() — so testing the full UI path doesn't depend
// on Google sensitive-scope verification landing first.
//
// Tenant-isolated via requireClientOwner; the body's locationName
// must match a CONNECTED ChannelConnection for this workspace or
// the ingestion returns UNKNOWN_ACCOUNT.
inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/_test/gbp-review`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      // Lazy import — the ingestion service uses Prisma at import
      // time too, but keeping this here so the test-injector
      // doesn't increase the cold-start surface for the more
      // common Inbox routes above.
      const { ingestGbpReview } = await import(
        "./inbox.gbp.ingestion.service.js"
      );
      const body = req.body ?? {};
      const result = await ingestGbpReview({
        locationName: body.locationName,
        reviewId:
          body.reviewId ??
          `${body.locationName}/reviews/sim_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}`,
        starRating: Number.isFinite(body.starRating) ? body.starRating : 5,
        comment: typeof body.comment === "string" ? body.comment : "",
        reviewer: {
          googleId: typeof body.reviewerId === "string" ? body.reviewerId : `sim_${Date.now()}`,
          displayName:
            typeof body.reviewerName === "string"
              ? body.reviewerName
              : "Test Reviewer (simulator)",
          isAnonymous: Boolean(body.anonymous),
        },
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
        sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
      });
      res.status(200).json(result);
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);
