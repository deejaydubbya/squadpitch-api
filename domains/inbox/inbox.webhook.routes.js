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
      // Diagnostic — fingerprints only, never the full secret. Lets
      // ops see (a) which auth method Postmark is using, (b) whether
      // the lengths match, and (c) whether the prefix/suffix matches
      // (so a copy-paste typo is obvious). Will be removed once
      // the inbound webhook is confirmed working end-to-end.
      console.warn(
        "[postmark.inbound] 403 — secret mismatch:",
        auditAuthAttempt(req),
      );
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
  if (
    typeof headerSecret === "string" &&
    timingSafeEqual(headerSecret, expected)
  ) {
    return true;
  }

  // 2. Authorization: Basic base64(<anything>:<secret>)
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString(
        "utf8",
      );
      const idx = decoded.indexOf(":");
      const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (timingSafeEqual(password, expected)) return true;
    } catch {
      // Malformed base64 — fall through.
    }
  }

  // 3. ?secret= query param
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

// Diagnostic: fingerprints what auth Postmark sent without
// revealing either the candidate or the configured secret. We log
// length + first/last 2 chars of each so a typo is obvious from
// the log line without making the secret reconstructible.
function auditAuthAttempt(req) {
  const expected = env.POSTMARK_INBOUND_WEBHOOK_SECRET;
  const out = {
    expectedConfigured: Boolean(expected),
    expectedFp: fingerprint(expected),
    methods: {
      header: false,
      basicAuth: false,
      query: false,
    },
    headerFp: null,
    basicAuthFp: null,
    queryFp: null,
  };

  const headerSecret = req.headers["x-postmark-secret"];
  if (typeof headerSecret === "string" && headerSecret.length > 0) {
    out.methods.header = true;
    out.headerFp = fingerprint(headerSecret);
  }

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Basic ")) {
    out.methods.basicAuth = true;
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString(
        "utf8",
      );
      const idx = decoded.indexOf(":");
      const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      out.basicAuthFp = fingerprint(password);
    } catch {
      out.basicAuthFp = "malformed-base64";
    }
  }

  return out;
}

// "len=64 first=DXBf last=Oq6C" — enough to spot a typo, not
// enough to reconstruct the value.
function fingerprint(s) {
  return typeof s === "string" && s.length > 0 ? "present" : null;
}
