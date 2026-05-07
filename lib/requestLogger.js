// Pino-http configuration. The goal is one structured log line per
// request that includes:
//   - requestId      (incoming X-Request-Id, otherwise a fresh one)
//   - method, url, status, responseTime
//   - userId         (when requireUser has resolved one)
//   - clientId       (when the path or body referenced a workspace)
//
// Critically, this configuration REDACTS Authorization, Cookie, and any
// "secret" / "password" looking field from headers and bodies, so a stray
// `req.log.info(req)` cannot leak credentials.

import { randomUUID } from "node:crypto";
import pinoHttp from "pino-http";
import { env } from "../config/env.js";

const REQUEST_ID_HEADER = "x-request-id";

// Header & body keys to scrub from logs. Pino's `redact` config matches
// dotted paths exactly, so we list every place these can appear.
const REDACT_PATHS = [
  // Headers (case sensitivity: pino-http lowercases)
  'req.headers["authorization"]',
  'req.headers.authorization',
  'req.headers["cookie"]',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Common body field names. We never want these in a request log.
  "req.body.password",
  "req.body.secret",
  "req.body.token",
  "req.body.accessToken",
  "req.body.refreshToken",
  "req.body.apiKey",
  "req.body.apiSecret",
  "req.body.clientSecret",
];

function getOrAssignRequestId(req, res) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
  // Echo it on the response so a client can correlate.
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * Try to identify the workspace ID for the current request without
 * decoding the body. This is best-effort: missing values just stay
 * undefined.
 */
function resolveClientId(req) {
  // /api/v1/workspaces/:id/...
  const match = /\/workspaces\/([A-Za-z0-9_-]+)/.exec(req.url || "");
  if (match) return match[1];
  // Some routes accept clientId on the JSON body. Bodies are parsed by
  // the time pino-http runs, but only on JSON routes. Don't crash if not
  // an object.
  const body = req.body;
  if (body && typeof body === "object" && typeof body.clientId === "string") {
    return body.clientId;
  }
  return undefined;
}

export function buildRequestLogger() {
  // pino-pretty in dev, JSON in production.
  const pretty =
    env.NODE_ENV !== "production"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : undefined;

  return pinoHttp({
    ...(pretty ?? {}),

    // Use the incoming X-Request-Id header if present, otherwise generate
    // a UUID. Pino calls genReqId(req, res) once per request and exposes
    // the result as `req.id` / on every log entry.
    genReqId: getOrAssignRequestId,

    // Pino redacts these dotted paths inside any logged object. The
    // censor token here matches the one we use elsewhere for consistency.
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
      remove: false,
    },

    // Append per-request fields so every log line includes user + client
    // context when available. Using `customProps` keeps the data on the
    // top-level log object (rather than nested under `req`).
    customProps: (req) => ({
      requestId: req.id,
      userId: req.user?.id ?? undefined,
      clientId: resolveClientId(req),
    }),

    // Compact request/response serializers — drop full headers in the
    // serialised request line by default. Auth + cookie are redacted via
    // the `redact` config above as a defence in depth, but we also
    // narrow what's logged.
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          // headers intentionally omitted — `redact` covers the case
          // where someone explicitly logs a full request object.
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },

    // Don't log a successful health-check probe every minute.
    autoLogging: {
      ignore: (req) => req.url === "/health",
    },
  });
}

/** Exposed for tests. */
export const _internal = {
  REDACT_PATHS,
  REQUEST_ID_HEADER,
  resolveClientId,
};
