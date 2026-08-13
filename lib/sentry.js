// Optional Sentry integration. Controlled entirely by env:
//   SENTRY_DSN              — if unset, every export below is a no-op.
//   SENTRY_ENVIRONMENT      — defaults to NODE_ENV.
//   SENTRY_TRACES_SAMPLE_RATE — float 0..1, defaults to 0.05 (5%).
//
// Designed so local dev and tests work without installing or configuring
// anything. The @sentry/node SDK is loaded with a dynamic import so the
// dependency is purely optional — `npm install @sentry/node` is the only
// thing needed to enable it. If the dependency is missing, a one-line
// warning is logged and we fall back to no-op.

import { env } from "../config/env.js";

let _sentry = null; // { captureException, requestHandler, errorHandler } | null
let _initStarted = false;

const SENSITIVE_KEY = /authorization|cookie|token|secret|password|passwd|api[-_]?key|phone|email|message|body|content/i;

export function redactSentryValue(value, depth = 0) {
  if (depth > 5) return "[Truncated]";
  if (Array.isArray(value)) return value.map((item) => redactSentryValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[Filtered]" : redactSentryValue(item, depth + 1),
  ]));
}

export function redactSentryEvent(event) {
  const sanitized = redactSentryValue(event);
  if (sanitized.request) {
    if (typeof sanitized.request.url === "string") {
      sanitized.request.url = sanitized.request.url
        .split("?")[0]
        .replace(/(\/preview\/)[A-Za-z0-9_-]{40,100}/g, "$1[Filtered]")
        .replace(/(\/public\/prospects\/preview\/)[A-Za-z0-9_-]{40,100}/g, "$1[Filtered]");
    }
    delete sanitized.request.headers;
    delete sanitized.request.cookies;
    delete sanitized.request.data;
  }
  if (sanitized.user) {
    delete sanitized.user.email;
    delete sanitized.user.ip_address;
    delete sanitized.user.username;
  }
  return sanitized;
}

/**
 * Lazy bootstrap. Safe to call from server.js before route mounting.
 * Returns true if Sentry was successfully initialized.
 */
export async function initSentry() {
  if (_initStarted) return Boolean(_sentry);
  _initStarted = true;

  const dsn = env.SENTRY_DSN;
  if (!dsn) {
    console.log("[SENTRY] SENTRY_DSN unset — error tracking disabled");
    return false;
  }

  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "production",
      release: env.SENTRY_RELEASE ?? env.APP_BUILD_SHA,
      tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0.05),
      sendDefaultPii: false,
      beforeSend: redactSentryEvent,
    });
    _sentry = Sentry;
    console.log("[SENTRY] Initialized — error tracking active");
    return true;
  } catch (err) {
    // Either the package isn't installed or init threw. Either way, we
    // never want this to crash the API.
    console.warn(
      "[SENTRY] Failed to initialize, continuing without it:",
      err?.message ?? err
    );
    _sentry = null;
    return false;
  }
}

function parseSampleRate(raw, fallback) {
  if (typeof raw !== "string" || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

/**
 * Sentry/node v8 removed `Sentry.Handlers.requestHandler` and
 * `errorHandler`. The request handler is no longer needed (the SDK
 * auto-instruments Express via the http integration once init() runs);
 * the error handler is wired with `setupExpressErrorHandler(app)`.
 *
 * We keep `sentryRequestHandler` exported as a no-op so server.js
 * doesn't have to branch — its only job in v8 is "after Sentry init".
 */
export function sentryRequestHandler() {
  return (_req, _res, next) => next();
}

/**
 * Mounts Sentry's official Express error handler onto the app, only
 * forwarding 5xx + non-status errors to Sentry. Safe to call when
 * Sentry isn't active — installs a passthrough instead.
 */
export function setupSentryErrorHandler(app) {
  if (_sentry?.setupExpressErrorHandler) {
    _sentry.setupExpressErrorHandler(app, {
      shouldHandleError: (e) => {
        const status = e?.status ?? e?.statusCode ?? 500;
        return status >= 500;
      },
    });
    return true;
  }
  return false;
}

/**
 * Back-compat shim for callers that still ask for a middleware fn. Returns
 * a no-op error handler — the real one is installed by setupSentryErrorHandler.
 */
export function sentryErrorHandler() {
  return (err, _req, _res, next) => next(err);
}

/**
 * Manually capture an exception. Use sparingly — most errors are picked
 * up by the express error handler above.
 */
export function captureException(err, context) {
  if (!_sentry) return undefined;
  try {
    return _sentry.captureException(err, context ? { extra: redactSentryValue(context) } : undefined);
  } catch {
    // Never let observability code break the request path.
  }
}

export function captureWorkerHealthIncident(err, safeTags = {}) {
  if (!_sentry) return undefined;
  try {
    return _sentry.withScope((scope) => {
      const tags = redactSentryValue(safeTags);
      for (const [key, value] of Object.entries(tags)) {
        if (value !== undefined && value !== null) scope.setTag(key, String(value));
      }
      scope.setFingerprint([
        "worker-health",
        String(tags.queue ?? "unknown"),
        String(tags.incident_type ?? "unknown"),
      ]);
      return _sentry.captureException(err);
    });
  } catch {
    return undefined;
  }
}

export async function captureSyntheticVerificationEvent() {
  if (!_sentry) return { configured: false, delivered: false, eventId: undefined };
  const eventId = _sentry.captureException(
    new Error("Squadpitch API production-readiness verification"),
    { tags: { synthetic: "true", source: "production-readiness", service: "squadpitch-api" } },
  );
  const delivered = await _sentry.flush(5000);
  return { configured: true, delivered, eventId };
}

export async function captureSyntheticWorkerHealthEvent() {
  if (!_sentry)
    return { configured: false, delivered: false, eventId: undefined };
  const eventId = _sentry.captureException(
    new Error("Squadpitch synthetic worker-health alert verification"),
    {
      tags: {
        synthetic: "true",
        source: "worker-health",
        service: "api-worker",
        environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
        severity: "warning",
      },
      fingerprint: ["worker-health", "synthetic-alert-verification"],
    },
  );
  const delivered = await _sentry.flush(5000);
  return { configured: true, delivered, eventId };
}

/** Test-only: reset module state. */
export function _resetSentryForTest() {
  _sentry = null;
  _initStarted = false;
}
