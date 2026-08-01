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
import { sendThreadsReply } from "./inbox.outbound.threads.service.js";
import { sendFacebookCommentReply } from "./inbox.outbound.facebook.service.js";
import { sendInstagramCommentReply } from "./inbox.outbound.instagram.service.js";
import { sendInboxSms } from "./inbox.outbound.sms.service.js";
import { isStopRequest, twilioDeliveryFailure } from "./twilioSafety.js";
import {
  SMS_AVAILABILITY,
  recordBlockedSmsAttempt,
} from "../sms/smsAvailability.js";

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

// Centralised outbound-send audit helper. Used by every send-*
// route so the audit table carries a consistent action vocabulary
// across providers. Body content is deliberately omitted — only
// the channel + outcome + ids are recorded (the Message row
// already preserves the body if anyone needs to inspect later).
async function auditOutboundAttempt(
  req,
  kind,
  conversationId,
  outcome,
  extras = {},
) {
  await writeAudit(req, {
    action: `inbox.outbound.${kind}.${outcome}`,
    resourceType: "Conversation",
    resourceId: conversationId,
    metadata: {
      clientId: req.params.id,
      channel: kind,
      ...extras,
    },
  });
}

// ── Conversations ──────────────────────────────────────────────────────

inboxRouter.get(
  `${BASE}/workspaces/:id/inbox/conversations`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListConversationsQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await service.listConversations(
        req.params.id,
        parsed.data,
      );
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
        return sendError(
          res,
          404,
          "CONVERSATION_NOT_FOUND",
          "Conversation not found",
        );
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
      // Capture the before-state so we can audit the delta. Only
      // workspace-meaningful fields are tracked; lastMessage*/read*
      // flip on every read and would flood the audit table.
      const { prisma } = await import("../../prisma.js");
      const before = await prisma.conversation.findUnique({
        where: { id: req.params.conversationId },
        select: { status: true, spam: true, assignedUserId: true },
      });
      const conversation = await service.updateConversation(
        req.params.id,
        req.params.conversationId,
        parsed.data,
      );
      // spinstr15 — audit the delta. Separate action names for the
      // two states the prompt cares about so a downstream report
      // can count spam flips vs status flips without parsing
      // metadata. Skip when nothing actually changed.
      const after = conversation;
      const delta = {};
      if (before && before.status !== after.status) {
        delta.status = { from: before.status, to: after.status };
      }
      if (before && before.spam !== after.spam) {
        delta.spam = { from: before.spam, to: after.spam };
      }
      if (before && before.assignedUserId !== after.assignedUserId) {
        delta.assignedUserId = {
          from: before.assignedUserId,
          to: after.assignedUserId,
        };
      }
      if (Object.keys(delta).length > 0) {
        const action =
          "spam" in delta
            ? delta.spam.to
              ? "inbox.conversation.spam.marked"
              : "inbox.conversation.spam.unmarked"
            : "status" in delta
              ? `inbox.conversation.status.${delta.status.to.toLowerCase()}`
              : "inbox.conversation.updated";
        await writeAudit(req, {
          action,
          resourceType: "Conversation",
          resourceId: conversation.id,
          metadata: { clientId: req.params.id, delta },
        });
      }
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
        typeof req.headers["idempotency-key"] === "string" &&
        req.headers["idempotency-key"].trim()
          ? req.headers["idempotency-key"].trim().slice(0, 128)
          : null;
      await auditOutboundAttempt(
        req,
        "email",
        req.params.conversationId,
        "attempt",
        {
          fromSuggestionId: parsed.data.fromSuggestionId ?? null,
        },
      );
      let message;
      try {
        message = await sendInboxEmail(
          req.params.id,
          req.params.conversationId,
          getAuth0Sub(req),
          { ...parsed.data, idempotencyKey },
        );
      } catch (sendErr) {
        await auditOutboundAttempt(
          req,
          "email",
          req.params.conversationId,
          "failure",
          {
            errorCode: sendErr?.code ?? null,
            errorStatus: sendErr?.status ?? null,
          },
        );
        throw sendErr;
      }
      await auditOutboundAttempt(
        req,
        "email",
        req.params.conversationId,
        "success",
        {
          messageId: message.id,
          providerMessageId: message.providerMessageId ?? null,
        },
      );
      // spinstr15 — when the user fired the send with an AI
      // suggestion attached, audit the acceptance explicitly so
      // analytics can tell "drafted" from "drafted + sent".
      if (parsed.data.fromSuggestionId) {
        await writeAudit(req, {
          action: "inbox.ai.suggestion.accepted",
          resourceType: "AIReplySuggestion",
          resourceId: parsed.data.fromSuggestionId,
          metadata: {
            clientId: req.params.id,
            conversationId: req.params.conversationId,
            channel: "email",
            messageId: message.id,
          },
        });
      }
      res.status(201).json({ message });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Send SMS reply (capability-gated) ──────────────────────────────────
//
// Hard-gated on env.SMS_SENDING_ENABLED + env.SMS_A2P_APPROVED in
// the outbound service — even if the resolver lets the UI render
// the Send SMS button, the server refuses to fire Twilio until
// Twilio Business Profile + A2P Brand + A2P Campaign are approved.
// The UI surfaces the reason verbatim ("Awaiting Twilio business
// profile / A2P 10DLC approval.").
inboxRouter.post(
  `${BASE}/workspaces/:id/inbox/conversations/:conversationId/send-sms`,
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
      await auditOutboundAttempt(
        req,
        "sms",
        req.params.conversationId,
        "attempt",
      );
      let message;
      try {
        message = await sendInboxSms(
          req.params.id,
          req.params.conversationId,
          getAuth0Sub(req),
          { body, idempotencyKey },
        );
      } catch (sendErr) {
        await auditOutboundAttempt(
          req,
          "sms",
          req.params.conversationId,
          "failure",
          {
            errorCode: sendErr?.code ?? null,
            errorStatus: sendErr?.status ?? null,
          },
        );
        throw sendErr;
      }
      await auditOutboundAttempt(
        req,
        "sms",
        req.params.conversationId,
        "success",
        {
          messageId: message.id,
          providerMessageId: message.providerMessageId ?? null,
        },
      );
      res.status(201).json({ message });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Twilio inbound webhook (signature-verified) ────────────────────────
//
// Twilio POSTs here when a contact replies. We verify the
// X-Twilio-Signature header BEFORE any DB write — without it a
// public caller could flip arbitrary contacts to smsOptOut=true.
// Signature is HMAC-SHA1 of (URL + sorted form params) using
// TWILIO_AUTH_TOKEN as the key. The URL must EXACTLY match what
// Twilio used to call us, so we read it from
// env.TWILIO_INBOUND_WEBHOOK_URL instead of reconstructing from
// req — Fly's proxy headers can drift.
//
// On STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT we flip
// Contact.enrichmentJson.smsOptOut=true so the outbound service
// short-circuits any future send to that contact. Real inbound
// message ingestion (turning their reply into a SquadInbox
// Message) is a follow-up.
// Twilio POSTs application/x-www-form-urlencoded by default. The
// global body parser in server.js only handles JSON, so we attach
// an urlencoded parser scoped to JUST this route. extended:false
// keeps the parsed shape flat (Twilio params are all top-level
// strings — From, Body, MessageSid, etc.).
const twilioWebhookBody = express.urlencoded({
  extended: false,
  limit: "256kb",
});

inboxRouter.post(
  `${BASE}/inbox/webhooks/twilio/inbound`,
  twilioWebhookBody,
  // No requireClientOwner — Twilio is the caller. The signature
  // check below is the only thing that gates this route.
  async (req, res) => {
    const { env } = await import("../../config/env.js");
    const signature = req.get?.("x-twilio-signature") ?? null;
    if (!signature) {
      return sendError(
        res,
        403,
        "MISSING_SIGNATURE",
        "X-Twilio-Signature header is required.",
      );
    }
    if (!env.TWILIO_AUTH_TOKEN) {
      // We can't validate without the secret — refuse rather than
      // silently accept. (Shouldn't happen in prod; defensive.)
      return sendError(
        res,
        403,
        "WEBHOOK_NOT_CONFIGURED",
        "Twilio webhook validation is not configured on the server.",
      );
    }
    let valid = false;
    try {
      const twilio = await import("twilio");
      valid = twilio.default.validateRequest(
        env.TWILIO_AUTH_TOKEN,
        signature,
        env.TWILIO_INBOUND_WEBHOOK_URL,
        req.body ?? {},
      );
    } catch (err) {
      console.error(
        "[INBOX_INBOUND_SMS] signature verify threw:",
        err?.message,
      );
      valid = false;
    }
    if (!valid) {
      return sendError(
        res,
        403,
        "INVALID_SIGNATURE",
        "Twilio signature failed verification.",
      );
    }

    if (SMS_AVAILABILITY.availability !== "enabled") {
      recordBlockedSmsAttempt("inbound");
      res.set("Content-Type", "text/xml");
      return res
        .status(200)
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    try {
      const from = typeof req.body?.From === "string" ? req.body.From : null;
      if (from && isStopRequest(req.body)) {
        const { prisma } = await import("../../prisma.js");
        const contacts = await prisma.contact.findMany({
          where: { phone: from },
          select: { id: true, enrichmentJson: true },
        });
        for (const c of contacts) {
          await prisma.contact.update({
            where: { id: c.id },
            data: {
              enrichmentJson: {
                ...(c.enrichmentJson ?? {}),
                smsOptOut: true,
                smsOptOutAt: new Date().toISOString(),
              },
            },
          });
        }
        console.log("[INBOX_INBOUND_SMS] STOP recorded:", {
          from,
          contacts: contacts.length,
        });
      }
      // Twilio expects an empty TwiML 200 response so it doesn't
      // retry. We don't reply to STOP from app code — Twilio's
      // Advanced Opt-Out emits the standard "You've been
      // unsubscribed" automatically.
      res.set("Content-Type", "text/xml");
      res
        .status(200)
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (err) {
      console.error("[INBOX_INBOUND_SMS] webhook error:", err?.message);
      res.set("Content-Type", "text/xml");
      res
        .status(500)
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  },
);

inboxRouter.post(
  `${BASE}/inbox/webhooks/twilio/status`,
  twilioWebhookBody,
  async (req, res) => {
    const { env } = await import("../../config/env.js");
    const signature = req.get?.("x-twilio-signature") ?? null;
    if (!signature || !env.TWILIO_AUTH_TOKEN) {
      return sendError(
        res,
        403,
        "INVALID_SIGNATURE",
        "Invalid Twilio signature.",
      );
    }
    try {
      const twilio = await import("twilio");
      const valid = twilio.default.validateRequest(
        env.TWILIO_AUTH_TOKEN,
        signature,
        env.TWILIO_STATUS_CALLBACK_URL,
        req.body ?? {},
      );
      if (!valid) {
        return sendError(
          res,
          403,
          "INVALID_SIGNATURE",
          "Invalid Twilio signature.",
        );
      }

      if (SMS_AVAILABILITY.availability !== "enabled") {
        recordBlockedSmsAttempt("status");
        return res.status(204).send();
      }

      const sid =
        typeof req.body?.MessageSid === "string" ? req.body.MessageSid : null;
      if (
        sid &&
        (!req.body?.AccountSid ||
          req.body.AccountSid === env.TWILIO_ACCOUNT_SID) &&
        twilioDeliveryFailure(req.body?.MessageStatus)
      ) {
        const { prisma } = await import("../../prisma.js");
        await prisma.message.updateMany({
          where: {
            providerMessageId: sid,
            channel: "SMS",
            deliveryStatus: { not: "FAILED" },
          },
          data: {
            deliveryStatus: "FAILED",
            errorReason: req.body?.ErrorCode
              ? `Twilio delivery failure ${req.body.ErrorCode}`
              : "Twilio reported delivery failure",
          },
        });
      }
      return res.status(204).send();
    } catch (err) {
      console.error("[INBOX_SMS_STATUS] processing failed", {
        errorName: err?.name,
      });
      return res.status(500).send();
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
      await auditOutboundAttempt(
        req,
        "review_reply",
        req.params.conversationId,
        "attempt",
      );
      let message;
      try {
        message = await sendGbpReviewReply(
          req.params.id,
          req.params.conversationId,
          getAuth0Sub(req),
          { body, idempotencyKey },
        );
      } catch (sendErr) {
        await auditOutboundAttempt(
          req,
          "review_reply",
          req.params.conversationId,
          "failure",
          {
            errorCode: sendErr?.code ?? null,
            errorStatus: sendErr?.status ?? null,
          },
        );
        throw sendErr;
      }
      await auditOutboundAttempt(
        req,
        "review_reply",
        req.params.conversationId,
        "success",
        {
          messageId: message.id,
        },
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
      // YOUTUBE, THREADS, FACEBOOK, INSTAGRAM are wired. LINKEDIN
      // stays gated (resolver short-circuits before the user can
      // click); other providers return 412.
      const { prisma } = await import("../../prisma.js");
      const conv = await prisma.conversation.findFirst({
        where: { id: req.params.conversationId, clientId: req.params.id },
        select: { provider: true },
      });
      if (!conv) {
        return sendError(
          res,
          404,
          "CONVERSATION_NOT_FOUND",
          "Conversation not found",
        );
      }
      const auditKind =
        conv.provider === "YOUTUBE"
          ? "youtube_comment"
          : conv.provider === "THREADS"
            ? "threads_reply"
            : conv.provider === "FACEBOOK"
              ? "facebook_comment"
              : conv.provider === "INSTAGRAM"
                ? "instagram_comment"
                : "comment_reply";
      await auditOutboundAttempt(
        req,
        auditKind,
        req.params.conversationId,
        "attempt",
      );
      let message;
      try {
        if (conv.provider === "YOUTUBE") {
          message = await sendYouTubeCommentReply(
            req.params.id,
            req.params.conversationId,
            getAuth0Sub(req),
            { body, idempotencyKey },
          );
        } else if (conv.provider === "THREADS") {
          message = await sendThreadsReply(
            req.params.id,
            req.params.conversationId,
            getAuth0Sub(req),
            { body, idempotencyKey },
          );
        } else if (conv.provider === "FACEBOOK") {
          message = await sendFacebookCommentReply(
            req.params.id,
            req.params.conversationId,
            getAuth0Sub(req),
            { body, idempotencyKey },
          );
        } else if (conv.provider === "INSTAGRAM") {
          message = await sendInstagramCommentReply(
            req.params.id,
            req.params.conversationId,
            getAuth0Sub(req),
            { body, idempotencyKey },
          );
        } else {
          await auditOutboundAttempt(
            req,
            auditKind,
            req.params.conversationId,
            "failure",
            {
              errorCode: "PROVIDER_NOT_AVAILABLE",
              errorStatus: 412,
            },
          );
          return sendError(
            res,
            412,
            "PROVIDER_NOT_AVAILABLE",
            `Public comment reply isn't connected yet for ${conv.provider}.`,
          );
        }
      } catch (sendErr) {
        await auditOutboundAttempt(
          req,
          auditKind,
          req.params.conversationId,
          "failure",
          {
            errorCode: sendErr?.code ?? null,
            errorStatus: sendErr?.status ?? null,
          },
        );
        throw sendErr;
      }
      await auditOutboundAttempt(
        req,
        auditKind,
        req.params.conversationId,
        "success",
        {
          messageId: message.id,
        },
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
      const { pollGbpReviewsForConnection } =
        await import("./gbpReviewPoller.service.js");
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

// ── Contact data export (GDPR-style portable JSON) ─────────────────────
//
// Returns everything we know about a single contact in this
// workspace, as a single JSON document. The workspace owner can
// hand this to the lead on request. Tenant-scoped via
// requireClientOwner; the lookup additionally filters by clientId
// so a stray contactId from another workspace 404s.
//
// What's included: Contact row + every Conversation + every
// Message (body included) + every Note. What's NOT: AI
// suggestions (those are workspace-internal artifacts about the
// contact, not authored by them).
inboxRouter.get(
  `${BASE}/workspaces/:id/inbox/contacts/:contactId/export`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { prisma } = await import("../../prisma.js");
      const contact = await prisma.contact.findFirst({
        where: { id: req.params.contactId, clientId: req.params.id },
        include: {
          conversations: {
            include: {
              messages: {
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  party: true,
                  channel: true,
                  body: true,
                  visibility: true,
                  externalMessageId: true,
                  deliveryStatus: true,
                  createdAt: true,
                },
              },
              notes: {
                orderBy: { createdAt: "asc" },
                select: { id: true, body: true, createdAt: true },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!contact) {
        return sendError(res, 404, "CONTACT_NOT_FOUND", "Contact not found");
      }
      await writeAudit(req, {
        action: "inbox.contact.exported",
        resourceType: "Contact",
        resourceId: contact.id,
        metadata: {
          clientId: req.params.id,
          conversationCount: contact.conversations.length,
        },
      });
      const filename = `squadpitch-contact-${contact.id}.json`;
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.json({
        exportedAt: new Date().toISOString(),
        workspaceId: req.params.id,
        contact,
      });
    } catch (err) {
      handleServiceError(res, err, next);
    }
  },
);

// ── Contact purge (manual, audit-logged) ───────────────────────────────
//
// Hard-deletes a contact and everything keyed off them: all of
// their Conversations (cascade pulls Messages + Notes +
// AIReplySuggestions). Tenant-scoped + audit-logged before the
// delete fires so an after-the-fact dispute has the actor + the
// deleted shape captured. There is no auto-purge worker; this
// route is the only path that destroys inbox PII.
inboxRouter.delete(
  `${BASE}/workspaces/:id/inbox/contacts/:contactId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { prisma } = await import("../../prisma.js");
      const contact = await prisma.contact.findFirst({
        where: { id: req.params.contactId, clientId: req.params.id },
        select: {
          id: true,
          email: true,
          phone: true,
          name: true,
          _count: { select: { conversations: true } },
        },
      });
      if (!contact) {
        return sendError(res, 404, "CONTACT_NOT_FOUND", "Contact not found");
      }
      // Audit BEFORE the delete so an audit-table failure doesn't
      // hide a destructive op. Body excluded from the metadata —
      // the contact's identity (email/phone/name) is enough for
      // the audit trail; the full payload was already captured
      // when the export endpoint ran, if the workspace user
      // chose to run it first.
      await writeAudit(req, {
        action: "inbox.contact.deleted",
        resourceType: "Contact",
        resourceId: contact.id,
        metadata: {
          clientId: req.params.id,
          conversationCount: contact._count.conversations,
          deletedIdentity: {
            email: contact.email,
            phone: contact.phone,
            name: contact.name,
          },
        },
      });
      // onDelete: Cascade on Conversation.contactId AND on
      // Message.conversationId means a single Contact.delete
      // takes everything with it.
      await prisma.contact.delete({ where: { id: contact.id } });
      res.status(204).send();
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
      const { ingestGbpReview } =
        await import("./inbox.gbp.ingestion.service.js");
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
          googleId:
            typeof body.reviewerId === "string"
              ? body.reviewerId
              : `sim_${Date.now()}`,
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
