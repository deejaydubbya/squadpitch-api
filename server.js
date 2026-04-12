import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { rateLimit } from "express-rate-limit";

import { env, bootEnvWarnings } from "./config/env.js";
import { prisma } from "./prisma.js";
import { getRedis } from "./redis.js";

// Domain routers
import { studioRouter } from "./domains/studio/studio.routes.js";
import { billingRouter } from "./domains/billing/billing.routes.js";
import { notificationRouter, notificationPublicRouter } from "./domains/notifications/notification.routes.js";
import { slackRouter } from "./domains/notifications/slack.routes.js";
import { webhookRouter } from "./domains/notifications/webhook.routes.js";
import { integrationRouter } from "./domains/integrations/integration.routes.js";

import { sendError, validationError } from "./lib/apiErrors.js";
import { requireAuth } from "./middleware/auth.js";
import { requireUser } from "./middleware/requireUser.js";

// ===== Boot warnings =====
bootEnvWarnings();

// ===== App =====
const app = express();
app.set("trust proxy", true);

// logging
const pretty =
  env.NODE_ENV !== "production"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : undefined;
app.use(pinoHttp(pretty ? pretty : {}));

// security / hardening
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://squadpitch-api.fly.dev", "https://*.auth0.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Raw body for Stripe webhook (must come before JSON parsing)
app.use(
  "/api/v1/billing/webhook",
  express.raw({ type: "application/json" })
);

// body parsing
app.use(express.json({ limit: "1mb" }));

// Raw body parsing for asset uploads (images + videos up to 500 MB)
app.use(
  "/api/v1",
  express.raw({ type: ["image/*", "video/*", "application/octet-stream"], limit: "500mb" })
);

// CORS
const fallbackAllowed = [
  "http://localhost:3000",
  /\.squadpitch\.com$/i,
  "https://squadpitch-web.fly.dev",
];
const parsedAllowed =
  env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) || [];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const list = parsedAllowed.length ? parsedAllowed : fallbackAllowed;
      const ok = list.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
      return ok ? cb(null, true) : cb(new Error("CORS: Origin not allowed"), false);
    },
    credentials: true,
  })
);

// baseline rate limit
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    validate: { trustProxy: false },
  })
);

// ===== Routes =====

// Health check — no auth
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "squadpitch-api" });
});

// Public notification routes (no auth) — VAPID key
app.use(notificationPublicRouter);

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

// Billing domain (webhook handler verifies via Stripe signature, not Bearer token)
app.use(billingRouter);

// Notifications domain
app.use(notificationRouter);

// Integrations (Slack, Webhooks, generic)
app.use(slackRouter);
app.use(webhookRouter);
app.use(integrationRouter);

// ===== Error handling =====
app.use((req, res) => {
  if (req.path === "/" || req.path === "") return res.redirect("/health");
  return sendError(res, 404, "NOT_FOUND", "Not found");
});

app.use((err, req, res, _next) => {
  const status = err?.status || err?.statusCode || 500;
  req.log?.error({ err, status }, "unhandled_error");

  if (err?.name === "ZodError") {
    return validationError(res, err.issues);
  }

  if (status === 401) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid token");
  }

  const message = status >= 500 ? "Internal Server Error" : (err.message || "Request failed");
  const code = status >= 500 ? "INTERNAL" : "REQUEST_FAILED";
  return sendError(res, status, code, message);
});

// ===== Boot & graceful shutdown =====
const httpServer = createServer(app);
let scheduledPublishWorker;
let mediaGenWorker;
let videoGenWorker;
let notificationWorker;
let weeklyDigestWorker;

let server;
(async () => {
  try {
    server = httpServer.listen(Number(env.PORT), "::", () => {
      console.log(`Squadpitch API listening on port ${env.PORT}`);
    });

    if (process.env.ENABLE_WORKERS === "true") {
      const { startScheduledPublishWorker } = await import(
        "./workers/scheduledPublishWorker.js"
      );
      scheduledPublishWorker = startScheduledPublishWorker();

      const { startMediaGenWorker } = await import(
        "./workers/mediaGenWorker.js"
      );
      mediaGenWorker = startMediaGenWorker();

      const { startVideoGenWorker } = await import(
        "./workers/videoGenWorker.js"
      );
      videoGenWorker = startVideoGenWorker();

      const { startNotificationWorker } = await import(
        "./workers/notificationWorker.js"
      );
      notificationWorker = startNotificationWorker();

      const { startWeeklyDigestWorker } = await import(
        "./workers/weeklyDigestWorker.js"
      );
      weeklyDigestWorker = startWeeklyDigestWorker();
    }
  } catch (e) {
    console.error("[BOOT] Failed to start server:", e);
    process.exit(1);
  }
})();

const shutdown = (sig) => async () => {
  console.log(`[SHUTDOWN] ${sig} received, closing server...`);
  try { if (scheduledPublishWorker) await scheduledPublishWorker.close(); } catch {}
  try { if (mediaGenWorker) await mediaGenWorker.close(); } catch {}
  try { if (videoGenWorker) await videoGenWorker.close(); } catch {}
  try { if (notificationWorker) await notificationWorker.close(); } catch {}
  try { if (weeklyDigestWorker) await weeklyDigestWorker.close(); } catch {}
  try {
    await new Promise((resolve) => server?.close?.(() => resolve()));
  } catch {}
  try { await prisma.$disconnect(); } catch {}
  try {
    const r = getRedis();
    if (r) await r.quit();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
