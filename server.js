import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

import { env, bootEnvWarnings } from "./config/env.js";
import { assertProductionConfig } from "./config/productionConfig.js";
import { buildRequestLogger } from "./lib/requestLogger.js";
import {
  initSentry,
  sentryRequestHandler,
  setupSentryErrorHandler,
} from "./lib/sentry.js";
import { prisma, isConnected, reconnectPrisma } from "./prisma.js";
import { getRedis, redisPing } from "./redis.js";

// Domain routers
import { studioRouter } from "./domains/studio/studio.routes.js";
import { conversionPublicRouter } from "./domains/studio/conversion.routes.js";
import { billingRouter } from "./domains/billing/billing.routes.js";
import {
  notificationRouter,
  notificationPublicRouter,
} from "./domains/notifications/notification.routes.js";
import { metaThreadsWebhookRouter } from "./domains/integrations/metaThreadsWebhook.routes.js";
import { publicSitesRouter } from "./domains/sites/public.routes.js";
import { sitesDashboardRouter } from "./domains/sites/sites.dashboard.routes.js";
import { inboxRouter } from "./domains/inbox/inbox.routes.js";
import { inboxWebhookRouter } from "./domains/inbox/inbox.webhook.routes.js";
import { adsRouter } from "./domains/ads/ads.routes.js";
import { slackRouter } from "./domains/notifications/slack.routes.js";
import { webhookRouter } from "./domains/notifications/webhook.routes.js";
import { integrationRouter } from "./domains/integrations/integration.routes.js";
import { mediaImportRouter } from "./domains/integrations/mediaImport.routes.js";
import { industryRouter } from "./domains/industry/industry.routes.js";
import { internalRouter } from "./domains/internal/internal.routes.js";
import { accountLifecycleRouter } from "./domains/account/accountLifecycle.routes.js";
import { canaryRouter } from "./domains/canary/canary.routes.js";

import { sendError, validationError } from "./lib/apiErrors.js";
import { requireAuth } from "./middleware/auth.js";
import { requireUser } from "./middleware/requireUser.js";

// ===== Boot warnings =====
assertProductionConfig(env);
bootEnvWarnings();

// ===== Sentry (optional — controlled by SENTRY_DSN) =====
// Production startup uses `node --import ./instrument.js server.js`,
// which initializes Sentry BEFORE this file is even loaded so v8 auto
// instrumentation can hook Express. The call below is idempotent and
// covers test/dev paths that import server.js directly without the
// pre-loader (e.g. tests/routeImports.test.js, ad-hoc node -e checks).
initSentry();

// ===== App =====
const app = express();
app.set("trust proxy", true);

// Sentry's request handler must run before any routes — captures req
// metadata so unhandled errors below carry context. No-op when SENTRY_DSN
// is absent.
app.use(sentryRequestHandler());

// Structured request logging — see lib/requestLogger.js. Adds
// requestId + userId + clientId to every log line, redacts secrets.
app.use(buildRequestLogger());

// security / hardening
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://squadpitch-api.fly.dev",
          "https://*.auth0.com",
        ],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// Raw body for Stripe webhook (must come before JSON parsing)
app.use("/api/v1/billing/webhook", express.raw({ type: "application/json" }));

// Larger JSON body limit for campaign image uploads (base64 payloads can be 10-30MB)
const largeJsonParser = express.json({ limit: "50mb" });
app.use((req, _res, next) => {
  if (req.url.includes("/listing-campaign/upload-images")) {
    largeJsonParser(req, _res, next);
  } else {
    next();
  }
});

// body parsing
app.use(express.json({ limit: "1mb" }));

// Raw body parsing for asset uploads (images + videos up to 500 MB)
app.use(
  "/api/v1",
  express.raw({
    type: ["image/*", "video/*", "application/octet-stream"],
    limit: "500mb",
  }),
);

// CORS
const fallbackAllowed = [
  "http://localhost:3000",
  /\.squadpitch\.com$/i,
  "https://squadpitch-web.fly.dev",
];
const parsedAllowed =
  env.ALLOWED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) || [];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const list =
        parsedAllowed.length || env.NODE_ENV === "production"
          ? parsedAllowed
          : fallbackAllowed;
      const ok = list.some((o) =>
        o instanceof RegExp ? o.test(origin) : o === origin,
      );
      return ok
        ? cb(null, true)
        : cb(new Error("CORS: Origin not allowed"), false);
    },
    credentials: true,
  }),
);

// baseline rate limit
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    validate: { trustProxy: false },
  }),
);

// ===== Routes =====

// Liveness: proves the process can serve HTTP. Dependency failures belong on
// /ready so the platform can distinguish restart-worthy process death from an
// upstream outage that needs investigation.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "squadpitch-api" });
});

// Readiness: safe, read-only dependency checks. Fly traffic checks should use
// this endpoint; external uptime checks should monitor both /health and /ready.
app.get("/ready", async (req, res) => {
  let dbOk = await isConnected();
  // Self-heal: when the Prisma engine loses its DB connection, this failing
  // health check is the ONLY thing that keeps firing — Fly pulls the machine
  // out of rotation, so no user requests reach requireUser's reconnect path
  // and the engine sits at db:false until a manual restart (see the ~1.5h
  // outage on 2026-07-01). Trigger a reconnect here so the machine recovers
  // on its own. reconnectPrisma() is mutex-guarded, so concurrent probes
  // share one in-flight reconnect cycle.
  if (!dbOk) {
    try {
      await reconnectPrisma();
      dbOk = await isConnected();
    } catch (err) {
      req.log?.error(
        { event: "database.readiness_reconnect_failed", err },
        "readiness dependency failure",
      );
    }
  }
  const redisOk = env.REDIS_URL ? await redisPing() : false;
  const ready = dbOk && redisOk;
  res
    .status(ready ? 200 : 503)
    .json({
      status: ready ? "ready" : "not_ready",
      service: "squadpitch-api",
      dependencies: { db: dbOk, redis: redisOk },
    });
});

// Public notification routes (no auth) — VAPID key
app.use(notificationPublicRouter);
app.use(conversionPublicRouter);
// Meta Threads webhook callbacks (no Bearer auth — verified via
// signed_request HMAC inside the router). Must mount before the
// /api auth middleware below.
app.use(metaThreadsWebhookRouter);

// SquadSites public surface — un-authed by design. Used by
// squadpitch-sites to resolve pages and accept form
// submissions. Must mount BEFORE the /api auth middleware so
// the resolve + form-submit routes don't get caught by
// requireAuth.
app.use(publicSitesRouter);

// SquadInbox inbound webhook — Postmark calls this directly to
// deliver parsed lead replies. Verified via shared-secret
// (POSTMARK_INBOUND_WEBHOOK_SECRET); no Bearer auth.
app.use(inboxWebhookRouter);

// Auth + user upsert for all /api/* routes EXCEPT the Stripe webhook
app.use("/api", (req, res, next) => {
  if (req.path === "/v1/billing/webhook") return next("route");
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    requireUser(req, res, next);
  });
});

// Studio domain
app.use(studioRouter);
app.use(accountLifecycleRouter);
app.use(canaryRouter);

// SquadSites authenticated dashboard surface. Mounted AFTER the
// global /api auth middleware — every route inside enforces
// workspace ownership via requireClientOwner.
app.use(sitesDashboardRouter);

// SquadInbox dashboard surface. Same auth pattern.
app.use(inboxRouter);

// SquadAds dashboard surface. Export-only MVP — no calls to any
// ad-platform API. Same auth pattern as Inbox.
app.use(adsRouter);

// Billing domain (webhook handler verifies via Stripe signature, not Bearer token)
app.use(billingRouter);

// Notifications domain
app.use(notificationRouter);

// Integrations (Slack, Webhooks, generic)
app.use(slackRouter);
app.use(webhookRouter);
app.use(integrationRouter);
app.use(mediaImportRouter);
app.use(industryRouter);

// Internal admin console
app.use(internalRouter);

// ===== Error handling =====
app.use((req, res) => {
  if (req.path === "/" || req.path === "") return res.redirect("/health");
  return sendError(res, 404, "NOT_FOUND", "Not found");
});

// Sentry's official Express error handler — must run BEFORE the JSON
// responder so unhandled 5xx errors carry full request context. v8 of
// @sentry/node installs the handler via setupExpressErrorHandler(app);
// the helper is a no-op when SENTRY_DSN is unset.
setupSentryErrorHandler(app);

app.use((err, req, res, _next) => {
  const status = err?.status || err?.statusCode || 500;
  req.log?.error({ err, status }, "unhandled_error");

  if (err?.name === "ZodError") {
    return validationError(res, err.issues);
  }

  if (status === 401) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid token");
  }

  const message =
    status >= 500 ? "Internal Server Error" : err.message || "Request failed";
  // Preserve a caller-supplied error code (e.g. CHANNEL_NOT_CONNECTED) for
  // non-5xx responses so the client can branch on it; never leak details
  // for 5xx.
  const code = status >= 500 ? "INTERNAL" : err?.code || "REQUEST_FAILED";
  // industry-01 — forward IndustryNotSupportedError extras
  // (actualIndustry / requiredIndustry) so the FE can render a
  // "this feature requires X industry" message + deep-link to
  // workspace settings. Only sent for non-5xx — 5xx never leaks
  // structured detail.
  const opts = {};
  if (status < 500) {
    if (err?.actualIndustry !== undefined)
      opts.actualIndustry = err.actualIndustry;
    if (err?.requiredIndustry !== undefined)
      opts.requiredIndustry = err.requiredIndustry;
  }
  return sendError(res, status, code, message, opts);
});

// ===== Boot & graceful shutdown =====
const httpServer = createServer(app);
let scheduledPublishWorker;
let mediaGenWorker;
let videoGenWorker;
let notificationWorker;
let weeklyDigestWorker;
let metricsSyncWorker;
let recalculateAnalyticsWorker;
let refreshInsightsWorker;
let personaTrainingWorker;
let gbpReviewPollerWorker;
let youtubeCommentPollerWorker;
let threadsReplyPollerWorker;
let facebookCommentPollerWorker;
let instagramCommentPollerWorker;
let autopilotEvaluatorWorker;

let server;
(async () => {
  try {
    // Eager-connect Prisma before accepting traffic — critical for Fly.io cold starts
    // where the database may also need to wake up (can take 5-10s).
    let dbConnected = false;
    for (let i = 0; i < 8; i++) {
      try {
        if (i > 0)
          await new Promise((r) => setTimeout(r, 1000 * Math.min(i, 4)));
        await prisma.$connect();
        console.log(`[BOOT] Prisma connected to database (attempt ${i + 1})`);
        dbConnected = true;
        break;
      } catch (err) {
        console.warn(
          `[BOOT] Prisma connect attempt ${i + 1}/8 failed: ${err.message}`,
        );
      }
    }
    if (!dbConnected) {
      console.error(
        "[BOOT] Could not connect to database after 8 attempts — starting anyway",
      );
    }

    server = httpServer.listen(Number(env.PORT), "::", () => {
      console.log(`Squadpitch API listening on port ${env.PORT}`);
    });

    if (env.ENABLE_WORKERS) {
      const { startScheduledPublishWorker } =
        await import("./workers/scheduledPublishWorker.js");
      scheduledPublishWorker = startScheduledPublishWorker();

      const { startMediaGenWorker } =
        await import("./workers/mediaGenWorker.js");
      mediaGenWorker = startMediaGenWorker();

      const { startVideoGenWorker } =
        await import("./workers/videoGenWorker.js");
      videoGenWorker = startVideoGenWorker();

      const { startNotificationWorker } =
        await import("./workers/notificationWorker.js");
      notificationWorker = startNotificationWorker();

      const { startWeeklyDigestWorker } =
        await import("./workers/weeklyDigestWorker.js");
      weeklyDigestWorker = startWeeklyDigestWorker();

      const { startMetricsSyncWorker } =
        await import("./workers/metricsSyncWorker.js");
      metricsSyncWorker = startMetricsSyncWorker();

      const { startRecalculateAnalyticsWorker } =
        await import("./workers/recalculateAnalyticsWorker.js");
      recalculateAnalyticsWorker = startRecalculateAnalyticsWorker();

      const { startRefreshInsightsWorker } =
        await import("./workers/refreshInsightsWorker.js");
      refreshInsightsWorker = startRefreshInsightsWorker();

      const { startPersonaTrainingWorker } =
        await import("./workers/personaTrainingWorker.js");
      personaTrainingWorker = startPersonaTrainingWorker();

      const { startGbpReviewPollerWorker } =
        await import("./workers/gbpReviewPollerWorker.js");
      gbpReviewPollerWorker = startGbpReviewPollerWorker();

      const { startYouTubeCommentPollerWorker } =
        await import("./workers/youtubeCommentPollerWorker.js");
      youtubeCommentPollerWorker = startYouTubeCommentPollerWorker();

      const { startThreadsReplyPollerWorker } =
        await import("./workers/threadsReplyPollerWorker.js");
      threadsReplyPollerWorker = startThreadsReplyPollerWorker();

      const { startFacebookCommentPollerWorker } =
        await import("./workers/facebookCommentPollerWorker.js");
      facebookCommentPollerWorker = startFacebookCommentPollerWorker();

      const { startInstagramCommentPollerWorker } =
        await import("./workers/instagramCommentPollerWorker.js");
      instagramCommentPollerWorker = startInstagramCommentPollerWorker();

      const { startAutopilotEvaluatorWorker } =
        await import("./workers/autopilotEvaluatorWorker.js");
      autopilotEvaluatorWorker = startAutopilotEvaluatorWorker();
    }
  } catch (e) {
    console.error("[BOOT] Failed to start server:", e);
    process.exit(1);
  }
})();

const shutdown = (sig) => async () => {
  console.log(`[SHUTDOWN] ${sig} received, closing server...`);
  try {
    if (scheduledPublishWorker) await scheduledPublishWorker.close();
  } catch {}
  try {
    if (mediaGenWorker) await mediaGenWorker.close();
  } catch {}
  try {
    if (videoGenWorker) await videoGenWorker.close();
  } catch {}
  try {
    if (notificationWorker) await notificationWorker.close();
  } catch {}
  try {
    if (weeklyDigestWorker) await weeklyDigestWorker.close();
  } catch {}
  try {
    if (metricsSyncWorker) await metricsSyncWorker.close();
  } catch {}
  try {
    if (recalculateAnalyticsWorker) await recalculateAnalyticsWorker.close();
  } catch {}
  try {
    if (refreshInsightsWorker) await refreshInsightsWorker.close();
  } catch {}
  try {
    if (personaTrainingWorker) await personaTrainingWorker.close();
  } catch {}
  try {
    if (gbpReviewPollerWorker) await gbpReviewPollerWorker.close();
  } catch {}
  try {
    if (youtubeCommentPollerWorker) await youtubeCommentPollerWorker.close();
  } catch {}
  try {
    if (threadsReplyPollerWorker) await threadsReplyPollerWorker.close();
  } catch {}
  try {
    if (facebookCommentPollerWorker) await facebookCommentPollerWorker.close();
  } catch {}
  try {
    if (instagramCommentPollerWorker)
      await instagramCommentPollerWorker.close();
  } catch {}
  try {
    if (autopilotEvaluatorWorker) await autopilotEvaluatorWorker.close();
  } catch {}
  try {
    await new Promise((resolve) => server?.close?.(() => resolve()));
  } catch {}
  try {
    await prisma.$disconnect();
  } catch {}
  try {
    const r = getRedis();
    if (r) await r.quit();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));

// ── Crash handlers ──────────────────────────────────────────────────────
// Prevent silent process death from unhandled promise rejections (common
// with stale DB connections in fire-and-forget paths like workers).
process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[PROCESS] Uncaught exception — shutting down:", err);
  // Give logs time to flush, then exit (systemd/Fly will restart us)
  setTimeout(() => process.exit(1), 1000);
});
