// SquadInbox — Meta Webhook receiver (Facebook Page + Instagram).
//
// Mounted BEFORE the global requireAuth middleware in server.js
// (same pattern as inboxWebhookRouter for Postmark inbound). Meta
// calls this directly with no Bearer token; security is the GET
// verify-token check + the POST X-Hub-Signature-256 HMAC check.
//
// Two endpoints share the same path:
//   GET  /api/v1/webhooks/meta/inbox — subscription verification
//                                       handshake. Meta sends
//                                       hub.challenge; we echo it
//                                       back only when hub.verify_token
//                                       matches META_WEBHOOK_VERIFY_TOKEN.
//   POST /api/v1/webhooks/meta/inbox — event delivery. Body is
//                                       HMAC-signed with META_APP_SECRET
//                                       in the X-Hub-Signature-256
//                                       header. We verify the signature
//                                       BEFORE parsing the JSON.
//
// Feature-flag posture (spinstr10):
//   META_INBOX_INGESTION_ENABLED=false (default) → the receiver
//   verifies the signature, records the payload shape to logs for
//   ops visibility, and 200-OKs without touching the DB. Lets us
//   ship the receiver before Meta App Review approves the new
//   scopes — pages_read_user_content + pages_manage_engagement
//   (Facebook Page comments + replies) and
//   instagram_business_manage_comments (Instagram comments under
//   the Instagram Login / Business Login scope family — Prompt 01
//   migration).
//
//   META_INBOX_INGESTION_ENABLED=true → dispatch to the ingestion
//   service which writes Conversation + Message rows.

import express from "express";
import { createHmac, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { sendError } from "../../lib/apiErrors.js";
import { processMetaWebhookPayload } from "./inbox.meta.ingestion.service.js";

export const inboxMetaWebhookRouter = express.Router();

// Path is global — kept in sync with the Meta App Dashboard
// subscription URL.
const PATH = "/api/v1/webhooks/meta/inbox";

// We need the RAW body bytes for HMAC verification. The default
// express.json() parser doesn't expose req.rawBody, so we use a
// per-route parser that captures it via the verify hook.
const rawJsonParser = express.json({
  limit: "5mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
});

// ── GET — subscription verification handshake ──────────────────────────
//
// Meta sends:
//   ?hub.mode=subscribe&hub.verify_token=<your token>&hub.challenge=<nonce>
// We echo hub.challenge as the raw response body — Meta accepts the
// subscription only when the response matches. Token comparison is
// timing-safe.
inboxMetaWebhookRouter.get(PATH, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode !== "subscribe") {
    console.warn("[meta.inbox] verify: unexpected hub.mode", { mode });
    return sendError(res, 400, "BAD_REQUEST", "Unexpected mode");
  }
  if (
    typeof token !== "string" ||
    typeof expected !== "string" ||
    expected.length === 0 ||
    !timingSafeEqualStrings(token, expected)
  ) {
    console.warn("[meta.inbox] verify: token mismatch (length-fingerprint only)", {
      hasExpected: Boolean(expected),
      expectedLen: expected?.length ?? 0,
      gotLen: typeof token === "string" ? token.length : 0,
    });
    return sendError(res, 403, "FORBIDDEN", "Invalid verify token");
  }
  if (typeof challenge !== "string" || challenge.length === 0) {
    return sendError(res, 400, "BAD_REQUEST", "Missing hub.challenge");
  }
  // Meta expects the raw challenge string back as the body. Status
  // text/plain so no quote-wrapping happens.
  res.status(200).type("text/plain").send(challenge);
});

// ── POST — event delivery ──────────────────────────────────────────────
//
// Signature verification: X-Hub-Signature-256 = "sha256=<hex>".
// Computed as HMAC-SHA256(req.rawBody, <app_secret>). Either
// META_APP_SECRET (Facebook product) or INSTAGRAM_APP_SECRET (the
// dedicated IG Business Login app) is accepted — see verifyHubSignature.
//
// Even when ingestion is disabled we still verify the signature —
// the only way Meta can know the receiver is healthy is by getting
// 200s back from properly signed requests. An unsigned attacker
// gets a 403; signed traffic 200s every time.
inboxMetaWebhookRouter.post(PATH, rawJsonParser, async (req, res, next) => {
  if (!verifyHubSignature(req)) {
    console.warn("[meta.inbox] 403 — signature mismatch", auditSigAttempt(req));
    return sendError(res, 403, "FORBIDDEN", "Invalid signature");
  }

  // Log the high-level shape so ops can see what Meta is actually
  // sending without writing anything sensitive. Body bodies / user
  // names are deliberately not logged (PII).
  const body = req.body ?? {};
  const summary = summarizePayload(body);
  console.log("[meta.inbox] received", summary);

  if (!env.META_INBOX_INGESTION_ENABLED) {
    // Feature-flag-off branch. We 200-OK so Meta doesn't retry,
    // but no DB writes happen. Lets us validate connectivity +
    // payload shape in production before App Review lands.
    return res.status(200).json({ ok: true, ingested: false, reason: "INGESTION_DISABLED" });
  }

  try {
    const result = await processMetaWebhookPayload(body);
    return res.status(200).json({ ok: true, ingested: true, ...result });
  } catch (err) {
    console.error("[meta.inbox] ingestion error:", {
      errorName: err?.name,
      errorMessage: err?.message,
      stack: err?.stack?.split("\n").slice(0, 5).join("\n"),
    });
    // Meta retries 5xx — we want that so a DB blip doesn't lose
    // the comment. Logical misses are NOT 5xx (they 200 with a
    // reason inside processMetaWebhookPayload).
    next(err);
  }
});

// ── Signature verification ─────────────────────────────────────────────

// Meta signs each webhook with the app secret of whichever app the
// subscription belongs to. Since IG-01..06 split Instagram onto a
// dedicated app (with its own INSTAGRAM_APP_SECRET) while Facebook
// stays on the original META_APP_SECRET, the verifier has to accept
// either secret. We try each in turn — both checks are timing-safe,
// and we only return false when neither matches. Order is
// META_APP_SECRET first since that's the historical path; ordering
// has no security impact because each candidate is itself constant-
// time-compared.
export function verifyHubSignature(req) {
  const header = req.headers["x-hub-signature-256"];
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);
  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) return false;

  const candidates = [env.META_APP_SECRET, env.INSTAGRAM_APP_SECRET].filter(
    (secret) => typeof secret === "string" && secret.length > 0,
  );
  if (candidates.length === 0) return false;

  for (const secret of candidates) {
    const expected = createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");
    if (provided.length !== expected.length) continue;
    try {
      if (
        cryptoTimingSafeEqual(
          Buffer.from(provided, "hex"),
          Buffer.from(expected, "hex"),
        )
      ) {
        return true;
      }
    } catch {
      // length-mismatch from a malformed hex slips here — keep trying
    }
  }
  return false;
}

// ── Helpers ────────────────────────────────────────────────────────────

function timingSafeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return cryptoTimingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

// PII-free fingerprint of an auth attempt — len + first/last 4
// chars only. Ops use this to diagnose dashboard-config typos
// without ever logging the real secret.
function auditSigAttempt(req) {
  const header = req.headers["x-hub-signature-256"];
  return {
    hasMetaSecret: Boolean(env.META_APP_SECRET),
    hasInstagramSecret: Boolean(env.INSTAGRAM_APP_SECRET),
    hasHeader: typeof header === "string",
    headerLen: typeof header === "string" ? header.length : 0,
    bodyLen: req.rawBody?.length ?? 0,
  };
}

// PII-free payload summary for logs — just the structure, no bodies.
function summarizePayload(body) {
  if (!body || typeof body !== "object") return { object: null, entries: 0 };
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const changes = entries.reduce((acc, e) => acc + (Array.isArray(e?.changes) ? e.changes.length : 0), 0);
  const messages = entries.reduce(
    (acc, e) => acc + (Array.isArray(e?.messaging) ? e.messaging.length : 0),
    0,
  );
  return {
    object: typeof body.object === "string" ? body.object : null,
    entries: entries.length,
    changes,
    messages,
  };
}
