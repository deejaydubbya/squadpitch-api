import express from "express";
import Stripe from "stripe";
import { env } from "../../config/env.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
import * as billingService from "./billing.service.js";
import { CreateCheckoutSchema, CreatePortalSchema } from "./billing.schemas.js";

export const billingRouter = express.Router();

const BASE = "/api/v1/billing";

// ── Get subscription ─────────────────────────────────────────────────────

billingRouter.get(`${BASE}/subscription`, async (req, res, next) => {
  try {
    const sub = await billingService.getSubscription(req.user.id);
    res.json({ subscription: sub });
  } catch (err) {
    next(err);
  }
});

// ── Get usage ────────────────────────────────────────────────────────────

billingRouter.get(`${BASE}/usage`, async (req, res, next) => {
  try {
    const usage = await billingService.getUsage(req.user.id);
    res.json(usage);
  } catch (err) {
    next(err);
  }
});

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
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return sendError(res, 400, "WEBHOOK_SIGNATURE_ERROR", `Webhook signature verification failed: ${err.message}`);
  }

  try {
    await billingService.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error("[BILLING WEBHOOK]", err);
    res.status(500).json({ received: false, error: "Internal error" });
  }
});
