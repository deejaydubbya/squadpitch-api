// Top-level pino logger for service / worker code paths that don't have
// access to `req.log`. pino-http (see lib/requestLogger.js) handles
// per-request logging; this is for everything else: BullMQ workers,
// background services, scheduled jobs.
//
// Two reasons we have a singleton instead of constructing pino in each
// caller:
//   1. Consistent output format (JSON in prod, pretty in dev).
//   2. The same redact config as pino-http, so a stray `logger.info(req)`
//      still scrubs Authorization / Cookie / secrets.

import pino from "pino";
import { env } from "../config/env.js";

const REDACT_PATHS = [
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["x-api-key"]',
  '*.password',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.apiSecret',
  '*.clientSecret',
];

function build() {
  const isProd = env.NODE_ENV === "production";
  return pino({
    level: env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]", remove: false },
    ...(isProd
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
          },
        }),
  });
}

export const logger = build();

/**
 * Log a structured "event" — a named, machine-grep-able line for high-value
 * business events (stripe.webhook.processed, publish.succeeded, etc.).
 *
 * Convention: events use dotted lowercase names; payload is whitelisted
 * fields only (no full request bodies, no secrets).
 */
export function logEvent(name, payload = {}) {
  logger.info({ event: name, ...payload });
}
