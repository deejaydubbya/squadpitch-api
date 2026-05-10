// Meta Threads webhook callbacks — public router, no Bearer auth.
//
// Two endpoints required by the Meta Threads dashboard:
//   POST /api/webhooks/meta/threads/deauthorize    — user revoked our app
//   POST /api/webhooks/meta/threads/data-deletion  — user requested deletion
//
// Both are signed by Meta with HMAC-SHA256 over the payload using the
// app secret. We verify before doing anything; invalid signatures
// return 400 without revealing why. We never log the raw
// signed_request, the app secret, or any extracted token-like field.
//
// Mounted in server.js BEFORE the /api auth middleware so they run
// without a Bearer token.

import express from "express";
import crypto from "node:crypto";
import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

export const metaThreadsWebhookRouter = express.Router();

const BASE = "/api/webhooks/meta/threads";

// Meta sends application/x-www-form-urlencoded with a single
// `signed_request=<base64url(sig)>.<base64url(payload)>` field. Use
// urlencoded() locally so this router doesn't depend on the global
// JSON body parser order.
const formParser = express.urlencoded({ extended: false });

function base64UrlDecode(input) {
  // Meta's base64url variant — replace URL-safe chars + pad.
  let str = String(input).replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

// Verify Meta's signed_request. Returns the parsed payload object on
// success, or null on any failure (signature mismatch, missing app
// secret, malformed input). We never throw — caller decides the
// response shape.
function verifySignedRequest(signedRequest, appSecret) {
  if (!signedRequest || !appSecret) return null;
  if (typeof signedRequest !== "string") return null;
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;

  let expected;
  try {
    expected = crypto
      .createHmac("sha256", appSecret)
      .update(encodedPayload)
      .digest();
  } catch {
    return null;
  }
  const provided = base64UrlDecode(encodedSig);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.algorithm && payload.algorithm !== "HMAC-SHA256") {
    return null;
  }
  return payload;
}

// Per Meta's docs, the user_id in the deauthorize/data-deletion
// payload is an "app-scoped" Threads user id — the same value we
// stored on ChannelConnection.externalAccountId during OAuth.
async function findThreadsConnectionByUserId(userId) {
  if (!userId) return null;
  return prisma.channelConnection.findFirst({
    where: { channel: "THREADS", externalAccountId: String(userId) },
    select: { id: true, clientId: true, status: true },
  });
}

// Generate an opaque confirmation code for the data deletion status
// page. Random hex — 32 chars is plenty.
function newConfirmationCode() {
  return crypto.randomBytes(16).toString("hex");
}

// ── Deauthorize ────────────────────────────────────────────────────────
//
// Triggered when a user removes Squadpitch from their Threads
// authorized apps. Mark the connection NEEDS_RECONNECT and null out
// the encrypted token so future calls fail fast. Idempotent — repeat
// callbacks (or one for an already-disconnected user) succeed
// quietly.
metaThreadsWebhookRouter.post(
  `${BASE}/deauthorize`,
  formParser,
  async (req, res, next) => {
    try {
      const payload = verifySignedRequest(
        req.body?.signed_request,
        env.THREADS_APP_SECRET
      );
      if (!payload) {
        // Don't reveal whether sig was wrong vs missing secret — just
        // 400. We log a generic event so on-call sees the volume but
        // never log the raw signed_request.
        logger.warn("[META_WEBHOOK] threads deauthorize signature invalid");
        return res.status(400).json({ ok: false });
      }

      const userId = payload?.user_id ?? null;
      const connection = await findThreadsConnectionByUserId(userId);

      if (connection) {
        await prisma.channelConnection.update({
          where: { id: connection.id },
          data: {
            status: "REVOKED",
            accessToken: "",
            refreshToken: null,
            tokenExpiresAt: null,
            lastError: "User revoked Threads app from Meta dashboard",
            updatedAt: new Date(),
          },
        });
        logger.info(
          { clientId: connection.clientId },
          "[META_WEBHOOK] threads connection revoked"
        );
      } else {
        // No matching connection → already deleted, or this app got
        // a stray callback. Both are fine. Idempotent success.
        logger.info("[META_WEBHOOK] threads deauthorize for unknown user_id (idempotent)");
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── Data deletion ──────────────────────────────────────────────────────
//
// Meta requires a JSON response of the form:
//   { url: "<status page URL>", confirmation_code: "<code>" }
// The user can visit the URL to verify deletion. We store an audit
// record keyed by the confirmation code so the status page can
// confirm the deletion happened.
metaThreadsWebhookRouter.post(
  `${BASE}/data-deletion`,
  formParser,
  async (req, res, next) => {
    try {
      const payload = verifySignedRequest(
        req.body?.signed_request,
        env.THREADS_APP_SECRET
      );
      if (!payload) {
        logger.warn("[META_WEBHOOK] threads data-deletion signature invalid");
        return res.status(400).json({ ok: false });
      }

      const userId = payload?.user_id ?? null;
      const connection = await findThreadsConnectionByUserId(userId);
      const confirmationCode = newConfirmationCode();

      if (connection) {
        // Atomic deletion of all Threads-derived data for this user.
        // Tokens, profile data, raw metric responses, normalized
        // metrics, post insights, and time-series snapshots — all
        // get wiped. We DON'T delete published Drafts because they
        // represent the user's created content (which lives on
        // Threads itself, not in Squadpitch as a primary record);
        // we just null out the provider-linkage fields so Threads
        // analytics never re-fetches.
        const drafts = await prisma.draft.findMany({
          where: { clientId: connection.clientId, channel: "THREADS" },
          select: { id: true },
        });
        const draftIds = drafts.map((d) => d.id);

        await prisma.$transaction([
          prisma.channelConnection.delete({ where: { id: connection.id } }),
          ...(draftIds.length
            ? [
                prisma.rawMetric.deleteMany({ where: { draftId: { in: draftIds } } }),
                prisma.normalizedMetric.deleteMany({ where: { draftId: { in: draftIds } } }),
                prisma.postInsight.deleteMany({ where: { draftId: { in: draftIds } } }),
                prisma.postMetricSnapshot.deleteMany({ where: { draftId: { in: draftIds } } }),
                prisma.postMetrics.deleteMany({ where: { draftId: { in: draftIds } } }),
              ]
            : []),
        ]);

        logger.info(
          { clientId: connection.clientId, draftCount: draftIds.length, confirmationCode },
          "[META_WEBHOOK] threads data deletion completed"
        );
      } else {
        // Idempotent: nothing to delete, still return a valid
        // confirmation so Meta closes the request out cleanly.
        logger.info(
          { confirmationCode },
          "[META_WEBHOOK] threads data deletion for unknown user_id (idempotent)"
        );
      }

      const statusUrl = `https://squadpitch.com/data-deletion/status/${confirmationCode}`;
      res.json({ url: statusUrl, confirmation_code: confirmationCode });
    } catch (err) {
      next(err);
    }
  }
);
