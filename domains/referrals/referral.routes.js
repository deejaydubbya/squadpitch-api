import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAdminRole } from "../../middleware/requireRole.js";
import { attachReferralAttribution, createCaptureForCode, getReferralDashboard, listAdminReferrals } from "./referral.service.js";

export const referralPublicRouter = Router();
export const referralRouter = Router();
const captureLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

referralPublicRouter.post("/api/public/referrals/:code/capture", captureLimiter, async (req, res, next) => {
  try {
    const capture = await createCaptureForCode(req.params.code);
    if (!capture) return res.status(404).json({ error: "REFERRAL_NOT_FOUND", message: "Referral link is invalid" });
    res.json(capture);
  } catch (error) { next(error); }
});

referralRouter.post("/api/v1/referrals/attribution", async (req, res, next) => {
  try { res.json(await attachReferralAttribution({ captureToken: req.body?.captureToken, user: req.user })); }
  catch (error) { next(error); }
});

referralRouter.get("/api/v1/referrals/me", async (req, res, next) => {
  try { res.json(await getReferralDashboard(req.user, { appUrl: process.env.APP_URL || "http://localhost:3000" })); }
  catch (error) { next(error); }
});

referralRouter.get("/api/v1/internal/referrals", requireAdminRole, async (_req, res, next) => {
  try { res.json({ items: await listAdminReferrals() }); } catch (error) { next(error); }
});
