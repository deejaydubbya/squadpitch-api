import { validateStripeMode } from "../domains/billing/stripeSafety.js";
import { validatePostmarkProductionConfig } from "../domains/inbox/postmarkSafety.js";
import { validateTwilioProductionConfig } from "../domains/inbox/twilioSafety.js";

const CORE_PRODUCTION_VARS = [
  "AUTH0_DOMAIN",
  "AUTH0_AUDIENCE",
  "DATABASE_URL",
  "ALLOWED_ORIGINS",
  "REDIS_URL",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "APP_URL",
  "OAUTH_STATE_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_EXPECTED_MODE",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_STARTER_PRICE_ID",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_GROWTH_PRICE_ID",
  "STRIPE_AGENCY_PRICE_ID",
  "POSTMARK_SERVER_TOKEN",
  "POSTMARK_MESSAGE_STREAM",
  "NOTIFICATION_FROM_EMAIL",
  "INBOX_EMAIL_FROM",
  "INBOX_EMAIL_REPLY_DOMAIN",
  "POSTMARK_INBOUND_WEBHOOK_SECRET",
  "AI_PLATFORM_INTERNAL_BASE_URL",
  "AI_PLATFORM_SERVICE_AUTH_KEY_ID",
  "AI_PLATFORM_SERVICE_AUTH_SECRET",
  "PUBLIC_SITES_BASE_DOMAIN",
  "RUNTIME_REVALIDATE_URL",
  "RUNTIME_REVALIDATE_TOKEN",
  "RUNTIME_IP_SALT",
];

const HTTPS_URL_VARS = ["APP_URL", "RUNTIME_REVALIDATE_URL"];

function isMissing(value) {
  return value == null || String(value).trim() === "";
}

function isLocalHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  );
}

function validateHttpsUrl(name, value, errors) {
  if (isMissing(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || isLocalHostname(url.hostname)) {
      errors.push(`${name} must be a public HTTPS URL in production`);
    }
  } catch {
    errors.push(`${name} must be a valid URL`);
  }
}

export function inspectProductionConfig(config) {
  const errors = [];
  const warnings = [];

  if (config.NODE_ENV !== "production") {
    return { errors, warnings };
  }

  for (const name of CORE_PRODUCTION_VARS) {
    if (isMissing(config[name])) errors.push(`${name} is required`);
  }

  for (const name of HTTPS_URL_VARS) {
    validateHttpsUrl(name, config[name], errors);
  }

  const origins = String(config.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const origin of origins) {
    validateHttpsUrl("ALLOWED_ORIGINS", origin, errors);
  }

  if (config.PINTEREST_USE_SANDBOX) {
    errors.push("PINTEREST_USE_SANDBOX must be false in production");
  }
  if (!config.ENABLE_WORKERS) {
    errors.push("ENABLE_WORKERS must be true in production");
  }
  errors.push(...validateStripeMode(config));
  errors.push(...validatePostmarkProductionConfig(config));
  errors.push(...validateTwilioProductionConfig(config));

  if (!config.SENTRY_DSN) warnings.push("SENTRY_DSN is not configured");
  if (!config.SENTRY_ENVIRONMENT) {
    warnings.push("SENTRY_ENVIRONMENT is not configured");
  }
  if (!config.OPENAI_API_KEY) {
    warnings.push("OPENAI_API_KEY is unavailable for explicit Node fallback");
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function assertProductionConfig(config, logger = console) {
  const result = inspectProductionConfig(config);

  for (const warning of result.warnings) {
    logger.warn(`[BOOT] Optional production configuration: ${warning}`);
  }
  if (result.errors.length) {
    throw new Error(
      `Unsafe production configuration:\n${result.errors
        .map((error) => `- ${error}`)
        .join("\n")}`,
    );
  }
  return result;
}

export { CORE_PRODUCTION_VARS };
