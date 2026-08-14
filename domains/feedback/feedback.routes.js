import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { validationError } from "../../lib/apiErrors.js";
import { getAuth0Sub } from "../../middleware/auth.js";
import { SubmitFeedbackSchema, safeFeedbackRoute } from "./feedback.schemas.js";
import { listOwnFeedback, submitFeedback } from "./feedback.service.js";

export const feedbackRouter = Router();
const submitLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

feedbackRouter.post("/api/v1/feedback", submitLimiter, async (req, res, next) => {
  try {
    const parsed = SubmitFeedbackSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const result = await submitFeedback({ input: { ...parsed.data, route: safeFeedbackRoute(parsed.data.route) }, user: req.user, auth0Sub: getAuth0Sub(req) });
    res.status(result.duplicate ? 200 : 201).json({ id: result.feedback.id, status: result.feedback.status, createdAt: result.feedback.createdAt });
  } catch (error) { next(error); }
});

feedbackRouter.get("/api/v1/feedback/mine", async (req, res, next) => {
  try { res.json({ items: await listOwnFeedback(req.user.id) }); } catch (error) { next(error); }
});
