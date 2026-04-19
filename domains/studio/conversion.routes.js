import express from "express";
import { resolveShortCode, incrementClickCount } from "./trackableLink.service.js";
import { logClickEvent } from "./conversionEvent.service.js";

export const conversionPublicRouter = express.Router();

// Simple in-memory rate limiter for redirect endpoint
const clickCounts = new Map();
const WINDOW_MS = 60_000;
const MAX_CLICKS = 60;

function rateLimitRedirect(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = clickCounts.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    clickCounts.set(ip, { windowStart: now, count: 1 });
    return next();
  }
  entry.count++;
  if (entry.count > MAX_CLICKS) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

// Periodic cleanup of rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of clickCounts) {
    if (now - entry.windowStart > WINDOW_MS * 2) clickCounts.delete(ip);
  }
}, WINDOW_MS * 2);

conversionPublicRouter.get("/r/:shortCode", rateLimitRedirect, async (req, res) => {
  try {
    const link = await resolveShortCode(req.params.shortCode);
    if (!link) return res.status(404).send("Link not found");

    // Fire-and-forget: log click + increment counter
    Promise.all([
      logClickEvent({
        trackableLinkId: link.id,
        clientId: link.clientId,
        draftId: link.draftId,
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.headers["user-agent"],
        referrerUrl: req.headers.referer || req.headers.referrer,
      }),
      incrementClickCount(link.id),
    ]).catch(() => {});

    // Build destination URL with UTM params
    const url = new URL(link.destinationUrl);
    if (link.utmSource) url.searchParams.set("utm_source", link.utmSource);
    if (link.utmMedium) url.searchParams.set("utm_medium", link.utmMedium);
    if (link.utmCampaign) url.searchParams.set("utm_campaign", link.utmCampaign);
    if (link.utmTerm) url.searchParams.set("utm_term", link.utmTerm);
    if (link.utmContent) url.searchParams.set("utm_content", link.utmContent);

    res.redirect(302, url.toString());
  } catch (err) {
    console.error("Redirect error:", err);
    res.status(500).send("Internal error");
  }
});
