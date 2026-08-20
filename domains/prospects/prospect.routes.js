import express from "express";
import { sendError } from "../../lib/apiErrors.js";
import { writeAudit } from "../../lib/auditLog.js";
import { rateLimit } from "express-rate-limit";
import { requireAuthoritativeVerifiedEmail, resendAuth0Verification, resolveAuthoritativeIdentity } from "../../lib/auth0Identity.js";
import * as service from "./prospect.service.js";
import { unsubscribe, trackOpen, trackClick, trackPreviewView, trackClaimStarted, ingestDeliveryEvent } from "./outreach.service.js";
import { env } from "../../config/env.js";

export const prospectPublicRouter = express.Router();
export const prospectClaimRouter = express.Router();
const PIXEL=Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==","base64");
prospectPublicRouter.get("/api/v1/public/outreach/track/open/:token.gif", async(req,res)=>{ try{await trackOpen(req.params.token,req.get("user-agent"));}catch{} res.set({"Cache-Control":"no-store","Content-Type":"image/gif"}).send(PIXEL); });
prospectPublicRouter.get("/api/v1/public/outreach/track/click/:token", async(req,res)=>{ try{const destination=await trackClick(req.params.token,req.get("user-agent"),req.method); if(destination)return res.redirect(302,destination);}catch{} return res.redirect(302,"/"); });
prospectPublicRouter.post("/api/v1/public/outreach/track/claim-start/:token", async(req,res)=>{ try{await trackClaimStarted(req.params.token,req.get("user-agent"));}catch{} res.status(204).end(); });
prospectPublicRouter.post("/api/v1/public/outreach/webhooks/delivery", async(req,res)=>{ if(!env.OUTREACH_DELIVERY_WEBHOOK_SECRET||req.get("x-outreach-webhook-secret")!==env.OUTREACH_DELIVERY_WEBHOOK_SECRET)return res.status(401).json({ok:false}); try{return res.json(await ingestDeliveryEvent(req.body||{}));}catch{return res.status(400).json({ok:false});} });

prospectPublicRouter.get("/api/v1/public/prospect-previews/:token", async (req, res, next) => {
  try {
    const preview = await service.getPublicPreview(req.params.token);
    if (!preview) return sendError(res, 404, "PREVIEW_UNAVAILABLE", "This preview is unavailable");
    await trackPreviewView(req.query?.outreach, req.params.token, req.get("user-agent")).catch(()=>false);
    res.set("Cache-Control", "private, no-store").json(preview);
  } catch (err) { next(err); }
});

prospectPublicRouter.post("/api/v1/public/prospect-claims/inspect", async (req, res, next) => {
  try {
    const claim = await service.inspectClaim(req.body?.claimToken);
    res.set("Cache-Control", "private, no-store").json(claim);
  } catch (err) { next(err); }
});

prospectPublicRouter.get("/api/v1/public/outreach/unsubscribe", async (req, res, next) => {
  try {
    const removed = await unsubscribe(req.query?.token);
    res.status(removed ? 200 : 404).type("html").send(removed ? "<h1>You have been unsubscribed.</h1><p>Squadpitch will not send further outreach to this address.</p>" : "<h1>This unsubscribe link is invalid.</h1>");
  } catch (err) { next(err); }
});

prospectClaimRouter.post("/api/v1/prospect-claims/claim", async (req, res, next) => {
  try {
    if (process.env.PROSPECT_WORKSPACE_CLAIMS_ENABLED === "false") return sendError(res, 503, "CLAIMS_DISABLED", "Workspace claiming is temporarily unavailable");
    const verifiedEmail = await requireAuthoritativeVerifiedEmail(req);
    const result = await service.claimWorkspace({ claimToken: req.body?.claimToken, user: req.user, auth0Sub: req.auth0Sub, verifiedEmail });
    await writeAudit(req, { action: "prospect.workspace.claimed", resourceType: "Client", resourceId: result.clientId, metadata: { userId: req.user.id } });
    res.json(result);
  } catch (err) { next(err); }
});

prospectClaimRouter.get("/api/v1/identity/verification", async (req, res, next) => {
  try {
    const identity = await resolveAuthoritativeIdentity(req);
    const claims = identity.emailVerified && identity.email ? await service.discoverPendingClaims(identity.email) : [];
    res.set("Cache-Control", "private, no-store").json({ email: identity.email || req.user?.email || null, emailVerified: identity.emailVerified, pendingClaims: claims });
  } catch (err) { next(err); }
});

prospectClaimRouter.get("/api/v1/workspace-invitations", async (req, res, next) => {
  try {
    const verifiedEmail = await requireAuthoritativeVerifiedEmail(req);
    const invitations = await service.discoverPendingClaims(verifiedEmail);
    res.set("Cache-Control", "private, no-store").json({ invitations, count: invitations.length });
  } catch (err) { next(err); }
});

prospectClaimRouter.get("/api/v1/workspace-invitations/:id/preview", async (req, res, next) => {
  try {
    const verifiedEmail = await requireAuthoritativeVerifiedEmail(req);
    const preview = await service.getInvitationPreview(req.params.id, verifiedEmail);
    if (!preview) return sendError(res, 404, "INVITATION_PREVIEW_UNAVAILABLE", "This workspace invitation is no longer available");
    res.set("Cache-Control", "private, no-store").json(preview);
  } catch (err) { next(err); }
});

prospectClaimRouter.post("/api/v1/identity/verification/resend", rateLimit({ windowMs: 15 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false }), async (req, res, next) => {
  try { res.json(await resendAuth0Verification(req)); } catch (err) { next(err); }
});

prospectClaimRouter.post("/api/v1/prospect-claims/:id/claim", async (req, res, next) => {
  try {
    const verifiedEmail = await requireAuthoritativeVerifiedEmail(req);
    const result = await service.claimWorkspace({ prospectId: req.params.id, user: req.user, auth0Sub: req.auth0Sub, verifiedEmail });
    await writeAudit(req, { action: "prospect.workspace.claimed", resourceType: "Client", resourceId: result.clientId, metadata: { userId: req.user.id, discovery: true } });
    res.json(result);
  } catch (err) { next(err); }
});

export const _internal = { resolveAuthoritativeIdentity };
