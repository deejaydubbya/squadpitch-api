import express from "express";
import { sendError } from "../../lib/apiErrors.js";
import { writeAudit } from "../../lib/auditLog.js";
import { env } from "../../config/env.js";
import * as service from "./prospect.service.js";

export const prospectPublicRouter = express.Router();
export const prospectClaimRouter = express.Router();

async function resolveVerifiedEmail(req) {
  const payload = req.auth?.payload ?? {};
  const email = payload.email || payload["https://squadpitch.com/email"];
  const verified = payload.email_verified === true || payload["https://squadpitch.com/email_verified"] === true;
  if (verified && typeof email === "string") return email;
  if (!req.auth?.token) return null;
  try {
    const response = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, { headers: { authorization: `Bearer ${req.auth.token}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const profile = await response.json();
    return profile?.email_verified === true && typeof profile.email === "string" ? profile.email : null;
  } catch { return null; }
}

prospectPublicRouter.get("/api/v1/public/prospect-previews/:token", async (req, res, next) => {
  try {
    const preview = await service.getPublicPreview(req.params.token);
    if (!preview) return sendError(res, 404, "PREVIEW_UNAVAILABLE", "This preview is unavailable");
    res.set("Cache-Control", "private, no-store").json(preview);
  } catch (err) { next(err); }
});

prospectPublicRouter.post("/api/v1/public/prospect-claims/inspect", async (req, res, next) => {
  try {
    const claim = await service.inspectClaim(req.body?.claimToken);
    res.set("Cache-Control", "private, no-store").json(claim);
  } catch (err) { next(err); }
});

prospectClaimRouter.post("/api/v1/prospect-claims/claim", async (req, res, next) => {
  try {
    if (process.env.PROSPECT_WORKSPACE_CLAIMS_ENABLED === "false") return sendError(res, 503, "CLAIMS_DISABLED", "Workspace claiming is temporarily unavailable");
    const verifiedEmail = await resolveVerifiedEmail(req);
    const result = await service.claimWorkspace({ claimToken: req.body?.claimToken, user: req.user, auth0Sub: req.auth0Sub, verifiedEmail });
    await writeAudit(req, { action: "prospect.workspace.claimed", resourceType: "Client", resourceId: result.clientId, metadata: { userId: req.user.id } });
    res.json(result);
  } catch (err) { next(err); }
});

export const _internal = { resolveVerifiedEmail };
