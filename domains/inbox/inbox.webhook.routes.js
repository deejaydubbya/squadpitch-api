// SquadInbox public webhook router.
//
// Mounted BEFORE the global requireAuth middleware in server.js
// (same pattern as metaThreadsWebhookRouter / publicSitesRouter)
// because Postmark calls us directly with no Bearer token.
// Security is the shared-secret check below, not the JWT auth
// stack.

import express from "express";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { sendError } from "../../lib/apiErrors.js";
import { processInboundEmail } from "./inbox.inbound.email.service.js";

export const inboxWebhookRouter = express.Router();

// Postmark inbound payloads can include base64-encoded attachments
// inline, easily exceeding the global 1mb express.json limit. We
// override on this route only — and we apply express.json HERE
// (not relying on the global one mounted in server.js) so the
// router's auth check can short-circuit before any large body
// parsing.
const inboundJsonParser = express.json({ limit: "20mb" });

inboxWebhookRouter.post(
  "/api/v1/webhooks/postmark/inbound",
  inboundJsonParser,
  async (req, res, next) => {
    // Secret verification — multi-shape so Postmark dashboard
    // configurations can pick whichever it supports. See
    // verifyWebhookSecret() below.
    if (!verifyWebhookSecret(req)) {
      // No diagnostic detail — we never log the candidate value
      // either, to avoid leaking the configured secret via tail logs.
      return sendError(res, 403, "FORBIDDEN", "Invalid webhook secret");
    }

    try {
      const result = await processInboundEmail(req.body ?? {});

      // Always 200 unless the DB itself errored. Postmark retries
      // non-2xx, and we want graceful no-ops for unknown
      // conversation ids or bad payloads so the retry queue doesn't
      // pile up. `result.reason` carries the disposition for logs.
      console.log("[postmark.inbound]", {
        reason: result.reason,
        messageId: result.messageId,
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("[postmark.inbound] db error:", {
        errorName: err?.name,
        errorMessage: err?.message,
        stack: err?.stack?.split("\n").slice(0, 5).join("\n"),
      });
      // Let the global error handler return 500 so Postmark retries.
      next(err);
    }
  },
);

// Multi-shape secret check. Postmark's dashboard supports HTTP
// Basic Auth on the webhook URL; some users prefer a query
// param. We accept both, plus a custom X-Postmark-Secret header
// for completeness (some tunneling setups inject headers).
//
// Constant-time comparisons on the candidate value to keep the
// check timing-safe.
export function verifyWebhookSecret(req) {
  const expected = env.POSTMARK_INBOUND_WEBHOOK_SECRET;
  if (!expected || typeof expected !== "string") return false;

  // 1. X-Postmark-Secret header
  const headerSecret = req.headers["x-postmark-secret"];
  if (typeof headerSecret === "string" && timingSafeEqual(headerSecret, expected)) {
    return true;
  }

  // 2. Authorization: Basic base64(<anything>:<secret>)
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (timingSafeEqual(password, expected)) return true;
    } catch {
      // Malformed base64 — fall through.
    }
  }

  // 3. ?secret= query param
  const querySecret = req.query?.secret;
  if (typeof querySecret === "string" && timingSafeEqual(querySecret, expected)) {
    return true;
  }

  return false;
}

// Constant-time string comparison. Node's crypto.timingSafeEqual
// requires equal-length buffers and throws otherwise; we wrap so
// a length mismatch is treated as false without leaking the
// timing difference between "wrong length" and "wrong value".
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return cryptoTimingSafeEqual(Buffer.from(a), Buffer.from(b));
}
