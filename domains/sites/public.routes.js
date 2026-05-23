// Public SquadSites API surface. Mounted UNDER /api/v1/public.
//
// Critical: this router is mounted BEFORE the auth middleware in
// server.js. Every handler must enforce its own auth model
// (none — these endpoints are intentionally un-authed), its own
// rate limit, and its own "PUBLISHED only" gate.

import express from "express";
import { resolvePublicPage, getActiveFormForSubmission, createFormSubmission } from "./sites.service.js";
import { checkRateLimit } from "./rateLimit.js";
import { hashIp, honeypotTripped, validateFormFields, getClientIp } from "./security.js";
import { sendError } from "../../lib/apiErrors.js";

export const publicSitesRouter = express.Router();

const BASE = "/api/v1/public";

// ── GET /api/v1/public/sites/resolve ────────────────────────────────
//
// Used by squadpitch-sites on every cache-miss render. Resolves
// host + path → page payload, gated to PUBLISHED-only content
// and bounded to a safe-to-surface response shape.
publicSitesRouter.get(`${BASE}/sites/resolve`, async (req, res, next) => {
  try {
    const { host, path: pagePath, locale } = req.query;
    if (typeof host !== "string" || !host) {
      return sendError(res, 400, "BAD_REQUEST", "host query param is required");
    }
    if (typeof pagePath !== "string") {
      return sendError(res, 400, "BAD_REQUEST", "path query param is required");
    }

    // Rate limit by host so a single misconfigured runtime can't
    // hammer the API. 60 resolves per second per host is enough
    // headroom for normal ISR refreshes (revalidate=60 default).
    const limit = await checkRateLimit("resolve-host", host.toLowerCase(), 60, 1);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSec));
      return sendError(res, 429, "RATE_LIMITED", "Too many requests");
    }

    const payload = await resolvePublicPage({
      host,
      path: pagePath,
      // Phase 2 multilingual — `?locale=es` asks for the Spanish
      // sibling; resolver gracefully falls back to English when no
      // matching sibling exists.
      locale: typeof locale === "string" ? locale : undefined,
    });
    if (!payload) {
      return sendError(res, 404, "NOT_FOUND", "Page not found");
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/public/forms/:formId/submit ────────────────────────
//
// Public form submission endpoint. Validates honeypot + fields,
// rate-limits per-IP + per-form, hashes IP, persists the
// submission. Returns successAction so the runtime can render
// the post-submit state. Never echoes back the submitted data.
publicSitesRouter.post(
  `${BASE}/forms/:formId/submit`,
  express.json({ limit: "32kb" }),                                  // hard cap on body size
  async (req, res, next) => {
    try {
      const { formId } = req.params;
      const fields = req.body?.fields;

      // Honeypot is silent — bots get a 200 so they don't learn
      // their trick was detected. We still log + skip the insert.
      if (honeypotTripped(fields)) {
        // Optionally count this against the rate-limit bucket to
        // dampen bursts.
        return res.json({ ok: true });
      }

      // Look up the form FIRST so a bad ID doesn't even count
      // against rate-limit buckets. Quick check before the
      // expensive validation work.
      const form = await getActiveFormForSubmission(formId);
      if (!form) {
        return sendError(res, 404, "FORM_NOT_FOUND", "Form not found");
      }

      const ip = getClientIp(req);
      const ipHash = hashIp(ip);

      // Per-IP and per-form rate limits. Each bucket is a
      // sliding-window 1-minute counter. The per-workspace
      // bucket protects against form spraying.
      const ipKey = ipHash || ip || "anon";
      const [ipLimit, formLimit, wsLimit] = await Promise.all([
        checkRateLimit("form-ip", ipKey, 5, 60),                    // 5/min per IP
        checkRateLimit("form-id", formId, 50, 60),                  // 50/min per form
        checkRateLimit("form-ws", form.clientId, 200, 60),          // 200/min per workspace
      ]);
      const blocked = [ipLimit, formLimit, wsLimit].find((l) => !l.allowed);
      if (blocked) {
        res.set("Retry-After", String(blocked.retryAfterSec));
        return sendError(res, 429, "RATE_LIMITED", "Too many submissions");
      }

      const validation = validateFormFields(form.fieldsJson, fields);
      if (!validation.ok) {
        return sendError(res, 400, "VALIDATION_ERROR", validation.errors.join("; "));
      }

      await createFormSubmission({
        form,
        fields: validation.fields,
        ipHash,
        userAgent: req.headers["user-agent"],
        referer: req.headers.referer || req.headers.referrer,
        pageId: req.body?.pageId,
        campaignId: req.body?.campaignId,
      });

      return res.json({
        ok: true,
        action: form.successAction || { type: "message", message: "Thanks!" },
      });
    } catch (err) {
      next(err);
    }
  }
);
