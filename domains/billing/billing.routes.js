import express from "express";
import Stripe from "stripe";
import { env } from "../../config/env.js";
import { STRIPE_API_VERSION } from "./stripeSafety.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
import { logEvent } from "../../lib/logger.js";
import * as billingService from "./billing.service.js";
import {
  getUsageForPeriod,
  getAiCostBreakdown,
} from "./aiUsageTracking.service.js";
import {
  getAllServicesHealth,
  checkBudgetStatus,
  getThrottlePolicy,
  setAdminFlag,
  clearAdminFlag,
} from "./serviceHealth.service.js";
import {
  CreateCheckoutSchema,
  CreatePortalSchema,
  ChangePlanSchema,
  SignupPlanSchema,
} from "./billing.schemas.js";
// requireAdminRole reads the Auth0 roles claim (squadpitch.com /
// mivalta.com fallback) and only lets through users with the "admin"
// role. The legacy requireAdmin middleware (env ADMIN_USER_IDS) is
// intentionally NOT used here — it lets a former-admin sub keep
// elevated access after role revocation in Auth0, and a developer-role
// user shouldn't pause AI generation for the whole platform.
import { requireAdminRole } from "../../middleware/requireRole.js";
import { writeAudit } from "../../lib/auditLog.js";

export const billingRouter = express.Router();

const BASE = "/api/v1/billing";

// ── Get subscription ─────────────────────────────────────────────────────

billingRouter.get(`${BASE}/subscription`, async (req, res, next) => {
  try {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : null;
    if (!clientId) {
      const sub = await billingService.getSubscription(req.user.id);
      return res.json({ subscription: sub, billingSource: sub ? "STRIPE" : "FREE" });
    }
    const entitlement = await billingService.getEffectiveEntitlement(req.user.id, clientId);
    res.json({
      subscription: entitlement.subscription,
      effectiveTier: entitlement.tier,
      billingSource: entitlement.source,
      internalEntitlement: entitlement.internalEntitlement ?? null,
    });
  } catch (err) {
    next(err);
  }
});

billingRouter.get(`${BASE}/trial`, async (req, res, next) => {
  try { res.json(await billingService.getTrialSummary(req.user.id)); } catch (err) { next(err); }
});

billingRouter.post(`${BASE}/trial/start`, async (req, res, next) => {
  try { res.status(201).json(await billingService.startFreeTrial({ userId: req.user.id, email: req.user.email })); } catch (err) { next(err); }
});

// ── Get plans (prices from Stripe) ──────────────────────────────────────

billingRouter.get(`${BASE}/plans`, async (req, res, next) => {
  try {
    const plans = await billingService.getPlans();
    res.json({ plans });
  } catch (err) {
    next(err);
  }
});

// ── Get usage ────────────────────────────────────────────────────────────

billingRouter.get(`${BASE}/usage`, async (req, res, next) => {
  try {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : null;
    const usage = await billingService.getUsage(req.user.id, clientId);
    res.json(usage);
  } catch (err) {
    next(err);
  }
});

// Internal entitlements are deliberately separate from Stripe state. These
// routes require an Auth0 admin role and an immutable workspace ID.
billingRouter.put(
  `${BASE}/admin/internal-entitlements/:clientId`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const tier = typeof req.body?.tier === "string" ? req.body.tier : "";
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!tier || !reason || reason.length < 8 || reason.length > 500) {
        return sendError(res, 400, "VALIDATION_ERROR", "A paid tier and reason (8-500 characters) are required");
      }
      const grant = await billingService.grantInternalEntitlement({
        clientId: req.params.clientId,
        tier,
        reason,
        actorSub: req.auth?.payload?.sub ?? "unknown",
        actorEmail: req.user?.email ?? null,
      });
      await writeAudit(req, {
        action: "internal_entitlement.grant",
        resourceType: "InternalEntitlement",
        resourceId: grant.id,
        metadata: { clientId: req.params.clientId, tier, reason },
      });
      res.json({ clientId: grant.clientId, tier: grant.tier, active: grant.active });
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.delete(
  `${BASE}/admin/internal-entitlements/:clientId`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (reason.length < 8 || reason.length > 500) {
        return sendError(res, 400, "VALIDATION_ERROR", "A revoke reason (8-500 characters) is required");
      }
      const grant = await billingService.revokeInternalEntitlement({
        clientId: req.params.clientId,
        reason,
        actorSub: req.auth?.payload?.sub ?? "unknown",
        actorEmail: req.user?.email ?? null,
      });
      await writeAudit(req, {
        action: "internal_entitlement.revoke",
        resourceType: "InternalEntitlement",
        resourceId: grant?.id ?? null,
        metadata: { clientId: req.params.clientId, reason, wasActive: Boolean(grant?.active) },
      });
      res.json({ clientId: req.params.clientId, active: false });
    } catch (err) {
      next(err);
    }
  },
);

// ── Create checkout session ──────────────────────────────────────────────

billingRouter.post(`${BASE}/checkout-session`, async (req, res, next) => {
  try {
    const parsed = CreateCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const result = await billingService.createCheckoutSession({
      userId: req.user.id,
      email: req.user.email,
      ...parsed.data,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Signup plan handoff ─────────────────────────────────────────────────

billingRouter.get(`${BASE}/signup-plan`, async (req, res, next) => {
  try {
    res.json(await billingService.getSignupPlanIntent(req.user.id));
  } catch (err) {
    next(err);
  }
});

billingRouter.put(`${BASE}/signup-plan`, async (req, res, next) => {
  try {
    const parsed = SignupPlanSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    res.json(
      await billingService.selectSignupPlan({
        userId: req.user.id,
        tier: parsed.data.tier,
      }),
    );
  } catch (err) {
    next(err);
  }
});

billingRouter.post(`${BASE}/signup-plan/checkout`, async (req, res, next) => {
  try {
    res.json(
      await billingService.resumeSignupCheckout({
        userId: req.user.id,
        email: req.user.email,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ── Create portal session ────────────────────────────────────────────────

billingRouter.post(`${BASE}/portal-session`, async (req, res, next) => {
  try {
    const parsed = CreatePortalSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const result = await billingService.createPortalSession({
      userId: req.user.id,
      ...parsed.data,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Change Plan (Upgrade / Downgrade) ───────────────────────────────────

billingRouter.post(`${BASE}/change-plan`, async (req, res, next) => {
  try {
    const parsed = ChangePlanSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const result = await billingService.changePlan({
      userId: req.user.id,
      newTier: parsed.data.tier,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Remaining usage ─────────────────────────────────────────────────────

billingRouter.get(`${BASE}/remaining`, async (req, res, next) => {
  try {
    const remaining = await billingService.getRemainingUsage(req.user.id);
    res.json(remaining);
  } catch (err) {
    next(err);
  }
});

// ── AI Usage Analytics ──────────────────────────────────────────────────

billingRouter.get(`${BASE}/ai-usage`, async (req, res, next) => {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const usage = await getUsageForPeriod(req.user.id, from, to);
    res.json({ period: { start: from, end: to }, usage });
  } catch (err) {
    next(err);
  }
});

billingRouter.get(`${BASE}/ai-cost-breakdown`, async (req, res, next) => {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const breakdown = await getAiCostBreakdown(req.user.id, from, to);
    res.json({ period: { start: from, end: to }, breakdown });
  } catch (err) {
    next(err);
  }
});

// ── System Health ───────────────────────────────────────────────────────

billingRouter.get(`${BASE}/system-health`, async (req, res, next) => {
  try {
    const [services, openai, fal] = await Promise.all([
      getAllServicesHealth(),
      checkBudgetStatus("openai"),
      checkBudgetStatus("fal"),
    ]);
    res.json({ services, budget: { openai, fal } });
  } catch (err) {
    next(err);
  }
});

// ── Admin Controls ──────────────────────────────────────────────────────

billingRouter.post(
  `${BASE}/admin/pause-ai`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await setAdminFlag("sp:admin:pause_ai");
      res.json({ ok: true, flag: "pause_ai", value: true });
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.post(
  `${BASE}/admin/resume-ai`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await clearAdminFlag("sp:admin:pause_ai");
      res.json({ ok: true, flag: "pause_ai", value: false });
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.post(
  `${BASE}/admin/disable-video`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await setAdminFlag("sp:admin:disable_video");
      res.json({ ok: true, flag: "disable_video", value: true });
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.post(
  `${BASE}/admin/enable-video`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      await clearAdminFlag("sp:admin:disable_video");
      res.json({ ok: true, flag: "disable_video", value: false });
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.get(
  `${BASE}/admin/status`,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const [services, openai, fal, throttle] = await Promise.all([
        getAllServicesHealth(),
        checkBudgetStatus("openai"),
        checkBudgetStatus("fal"),
        getThrottlePolicy(),
      ]);
      res.json({ services, budget: { openai, fal }, throttle });
    } catch (err) {
      next(err);
    }
  },
);

// ── Stripe webhook ───────────────────────────────────────────────────────
// NOTE: This route needs raw body. It's mounted separately in server.js
//       before JSON parsing middleware.

billingRouter.post(`${BASE}/webhook`, async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!sig || !env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return sendError(res, 400, "WEBHOOK_ERROR", "Webhook not configured");
  }

  let event;
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
    });
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    logEvent("stripe.webhook.signature_failed", { error: err.message });
    return sendError(
      res,
      400,
      "WEBHOOK_SIGNATURE_ERROR",
      `Webhook signature verification failed: ${err.message}`,
    );
  }

  logEvent("stripe.webhook.received", {
    stripeEventId: event.id,
    type: event.type,
  });

  try {
    await billingService.handleWebhookEvent(event);
    logEvent("stripe.webhook.processed", {
      stripeEventId: event.id,
      type: event.type,
    });
    res.json({ received: true });
  } catch (err) {
    logEvent("stripe.webhook.failed", {
      stripeEventId: event.id,
      type: event.type,
      error: err?.message ?? "unknown",
    });
    res.status(500).json({ received: false, error: "Internal error" });
  }
});
