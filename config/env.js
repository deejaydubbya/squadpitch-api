import "dotenv/config";
import { assertStripeEnvConfigured } from "../domains/billing/billing.constants.js";

export const env = {
  PORT: process.env.PORT ?? "8080",
  AUTH0_DOMAIN: process.env.AUTH0_DOMAIN,
  AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE,
  DATABASE_URL: process.env.DATABASE_URL,
  // Never infer production. Fly sets this explicitly; local and one-off
  // processes should not silently activate production-only behavior.
  NODE_ENV: process.env.NODE_ENV ?? "development",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,

  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,

  REDIS_URL: process.env.REDIS_URL,
  PROCESS_ROLE:
    process.env.PROCESS_ROLE ||
    (process.env.NODE_ENV === "test" ? "test" : "api"),
  ENABLE_WORKERS:
    String(process.env.ENABLE_WORKERS ?? "false").toLowerCase() === "true",
  ALLOW_EXTERNAL_REDIS_IN_TEST:
    String(process.env.ALLOW_EXTERNAL_REDIS_IN_TEST ?? "false").toLowerCase() ===
    "true",
  PRODUCTION_CANARY_WORKSPACE_ID: process.env.PRODUCTION_CANARY_WORKSPACE_ID,
  PRODUCTION_CANARY_MEDIA_ENABLED:
    String(
      process.env.PRODUCTION_CANARY_MEDIA_ENABLED ?? "false",
    ).toLowerCase() === "true",
  PRODUCTION_CANARY_SITES_HEALTH_URL:
    process.env.PRODUCTION_CANARY_SITES_HEALTH_URL,

  // OpenAI — text generation
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_DEFAULT_MODEL: process.env.OPENAI_DEFAULT_MODEL ?? "gpt-4o-mini",

  // Jina Reader — URL scraping
  JINA_API_KEY: process.env.JINA_API_KEY,

  // Fal.ai — image/video generation
  FAL_API_KEY: process.env.FAL_API_KEY,
  FAL_DEFAULT_MODEL: process.env.FAL_DEFAULT_MODEL ?? "fal-ai/flux/dev",

  // Replicate — SAM 2 screenshot segmentation (listing media extraction).
  //
  // The versionless `meta/sam-2` slug is only valid for models flagged as
  // `official` by Replicate. `meta/sam-2` is NOT official, so the default
  // version route 404s — we have to pin the version hash. Override via env
  // if Replicate publishes a newer version.
  REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
  REPLICATE_SAM2_MODEL:
    process.env.REPLICATE_SAM2_MODEL ??
    "meta/sam-2:fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83",

  // Meta / Facebook OAuth — Facebook Login app (Page scopes).
  META_APP_ID: process.env.META_APP_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_OAUTH_REDIRECT_URI: process.env.META_OAUTH_REDIRECT_URI,

  // Instagram Login / Business Login app (instagram_business_*
  // scopes, including instagram_business_manage_comments for the
  // Inbox comments ingestion path). May be a SEPARATE Meta App
  // from META_APP_ID — the Instagram API surface is a distinct
  // product. Falls back to META_* in instagram.oauth.js for
  // migration convenience until ops moves Instagram onto its own
  // app credentials.
  INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET,
  INSTAGRAM_OAUTH_REDIRECT_URI: process.env.INSTAGRAM_OAUTH_REDIRECT_URI,

  // Meta Inbox ingestion (FB Page comments + IG comments) is
  // polling-based — no webhook env vars required. The polling
  // service in domains/inbox/ runs on a cron tick and calls Graph
  // directly using the per-connection access token. The previous
  // webhook receiver (META_WEBHOOK_VERIFY_TOKEN /
  // META_INBOX_INGESTION_ENABLED) was removed June 2026 because
  // Meta requires apps to be Live before delivering real production
  // webhook events; polling sidesteps that gate entirely.
  //
  // META_COMMENT_POLLING_* gate the BACKGROUND scheduler only.
  // Manual sync routes (POST .../sync-comments) always work for
  // ops + demo + dev, regardless of these flags. The scheduler is
  // OFF by default so a fresh deploy doesn't start hitting Graph
  // for every connected workspace on day one — flip it on after
  // confirming credentials and quotas are in place.
  META_COMMENT_POLLING_ENABLED:
    String(
      process.env.META_COMMENT_POLLING_ENABLED ?? "false",
    ).toLowerCase() === "true",
  META_COMMENT_POLLING_INTERVAL_MINUTES: (() => {
    const n = Number.parseInt(
      process.env.META_COMMENT_POLLING_INTERVAL_MINUTES,
      10,
    );
    return Number.isFinite(n) && n > 0 ? n : 15;
  })(),
  META_COMMENT_POLLING_LOOKBACK_DAYS: (() => {
    const n = Number.parseInt(
      process.env.META_COMMENT_POLLING_LOOKBACK_DAYS,
      10,
    );
    return Number.isFinite(n) && n > 0 ? n : 30;
  })(),

  // OAuth state signing (HMAC secret, random 32+ bytes)
  OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,

  // Token encryption (base64-encoded 32 bytes for AES-256-GCM)
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,

  // SquadSites — public runtime integration (Phase B).
  // PUBLIC_SITES_BASE_DOMAIN is the hostname suffix the resolve
  // endpoint accepts. Must match the value set on the
  // squadpitch-sites runtime (default "squadpitchsites.com").
  PUBLIC_SITES_BASE_DOMAIN: process.env.PUBLIC_SITES_BASE_DOMAIN,
  // RUNTIME_REVALIDATE_URL points at the squadpitch-sites
  // /api/revalidate endpoint so the API can drop cached pages
  // immediately on publish. Token must match the value the
  // runtime expects (same secret on both apps).
  RUNTIME_REVALIDATE_URL: process.env.RUNTIME_REVALIDATE_URL,
  RUNTIME_REVALIDATE_TOKEN: process.env.RUNTIME_REVALIDATE_TOKEN,
  // Salt used by FormSubmission IP hashing. Must match the
  // runtime's RUNTIME_IP_SALT so dedupe + abuse tracking work
  // across both sides. Generate with: openssl rand -base64 32
  RUNTIME_IP_SALT: process.env.RUNTIME_IP_SALT,

  // TikTok
  TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY,
  TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET,
  TIKTOK_REDIRECT_URI: process.env.TIKTOK_REDIRECT_URI,

  // LinkedIn — Personal Profile (Sign In + Share products)
  LINKEDIN_CLIENT_ID: process.env.LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET: process.env.LINKEDIN_CLIENT_SECRET,
  LINKEDIN_REDIRECT_URI: process.env.LINKEDIN_REDIRECT_URI,

  // LinkedIn — Organization Page (Community Management API product)
  // Distinct LinkedIn developer app — keeps personal-profile scopes
  // separate from organization-admin scopes per LinkedIn requirements.
  LINKEDIN_ORG_CLIENT_ID: process.env.LINKEDIN_ORG_CLIENT_ID,
  LINKEDIN_ORG_CLIENT_SECRET: process.env.LINKEDIN_ORG_CLIENT_SECRET,
  LINKEDIN_ORG_REDIRECT_URI: process.env.LINKEDIN_ORG_REDIRECT_URI,
  // Comma-separated. Defaults match LinkedIn's documented Community
  // Management API scopes; override if your app's audit landed
  // different ones.
  LINKEDIN_ORG_SCOPES:
    process.env.LINKEDIN_ORG_SCOPES ??
    "r_organization_admin,w_organization_social,r_organization_social",

  // Pinterest (API v5)
  PINTEREST_CLIENT_ID: process.env.PINTEREST_CLIENT_ID,
  PINTEREST_CLIENT_SECRET: process.env.PINTEREST_CLIENT_SECRET,
  PINTEREST_REDIRECT_URI: process.env.PINTEREST_REDIRECT_URI,
  // Pinterest gates Trial-access apps from creating Pins on production
  // (api.pinterest.com) — error code 29:
  //   "Apps with Trial access may not create Pins in production ... use
  //    API Sandbox https://api-sandbox.pinterest.com instead."
  // Set PINTEREST_USE_SANDBOX=true to point all v5 API calls (token
  // exchange, user account, boards listing, Pin creation) at the
  // sandbox host so a Trial app can complete the publish flow end to
  // end. Leave unset / "false" once the app is granted Standard access.
  PINTEREST_USE_SANDBOX:
    String(process.env.PINTEREST_USE_SANDBOX ?? "").toLowerCase() === "true",

  // X (Twitter)
  X_CLIENT_ID: process.env.X_CLIENT_ID,
  X_CLIENT_SECRET: process.env.X_CLIENT_SECRET,
  X_REDIRECT_URI: process.env.X_REDIRECT_URI,

  // YouTube (Google)
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI,

  // Google Business Profile — Inbox reviews channel. Separate OAuth
  // client from YouTube because the scope (business.manage) requires
  // Google sensitive-scope verification independent of the YouTube
  // scope set. Same Google Cloud project is fine; different client.
  GOOGLE_BUSINESS_PROFILE_CLIENT_ID:
    process.env.GOOGLE_BUSINESS_PROFILE_CLIENT_ID,
  GOOGLE_BUSINESS_PROFILE_CLIENT_SECRET:
    process.env.GOOGLE_BUSINESS_PROFILE_CLIENT_SECRET,
  GOOGLE_BUSINESS_PROFILE_REDIRECT_URI:
    process.env.GOOGLE_BUSINESS_PROFILE_REDIRECT_URI,

  // Threads (Meta — separate Threads-only app, NOT the existing
  // Facebook/Instagram app). Threads has its own developer app on
  // developers.facebook.com with its own client_id/secret and uses the
  // graph.threads.net host (not graph.facebook.com).
  // See docs/THREADS_SETUP.md for app config + Fly secrets commands.
  THREADS_APP_ID: process.env.THREADS_APP_ID,
  THREADS_APP_SECRET: process.env.THREADS_APP_SECRET,
  THREADS_REDIRECT_URI: process.env.THREADS_REDIRECT_URI,
  // Meta-required public webhook callbacks.
  THREADS_UNINSTALL_CALLBACK_URL: process.env.THREADS_UNINSTALL_CALLBACK_URL,
  THREADS_DELETE_CALLBACK_URL: process.env.THREADS_DELETE_CALLBACK_URL,
  THREADS_API_VERSION: process.env.THREADS_API_VERSION ?? "v1.0",
  // Operational kill-switch. When false, OAuth start/exchange and
  // publish dispatch reject with THREADS_DISABLED. Lets us hold the
  // channel back while App Review is pending without rolling back
  // code. Defaults true in production once configured.
  // THREADS_INTEGRATION_ENABLED is an accepted alias for
  // THREADS_ENABLED — the prompt that introduced the Threads
  // Inbox integration used the longer name, and we honor either
  // so docs and Fly secrets commands work as written without a
  // rename migration.
  THREADS_ENABLED:
    String(
      process.env.THREADS_ENABLED ??
        process.env.THREADS_INTEGRATION_ENABLED ??
        "true",
    ).toLowerCase() === "true",
  // Autopilot scheduler — default OFF so a deploy doesn't start
  // a fleet-wide eval loop on day one. When ENABLED is true, the
  // autopilotEvaluatorWorker fires every INTERVAL_MIN minutes
  // and calls runScheduledAutopilot for each opt-in workspace.
  // The internal evaluate-all endpoint stays available either
  // way for external cron + manual triggers.
  AUTOPILOT_SCHEDULER_ENABLED:
    String(process.env.AUTOPILOT_SCHEDULER_ENABLED ?? "false").toLowerCase() ===
    "true",
  AUTOPILOT_SCHEDULER_INTERVAL_MIN:
    Number(process.env.AUTOPILOT_SCHEDULER_INTERVAL_MIN) > 0
      ? Number(process.env.AUTOPILOT_SCHEDULER_INTERVAL_MIN)
      : 360, // 6 hours default

  // Per-feature gate for the SquadInbox reply path. Default OFF
  // so a fresh deploy doesn't accidentally start posting public
  // replies on Threads. The resolver + outbound service both
  // check this flag before any Threads write.
  THREADS_REPLY_ENABLED:
    String(process.env.THREADS_REPLY_ENABLED ?? "false").toLowerCase() ===
    "true",
  // Per-feature gate for the Threads publish adapter (organic
  // content publishing from Squadpitch Studio). Default OFF
  // until the workspace has explicitly opted in — flipping this
  // false halts publishPost at the channel-dispatch level so
  // even a scheduled Draft won't fire on the wrong workspace.
  THREADS_PUBLISHING_ENABLED:
    String(process.env.THREADS_PUBLISHING_ENABLED ?? "false").toLowerCase() ===
    "true",
  // Per-feature gate for any Threads insights fetcher. Default
  // OFF. Reserved for the analytics sync worker once it's wired
  // for Threads — Inbox functionality must NOT depend on this.
  THREADS_INSIGHTS_ENABLED:
    String(process.env.THREADS_INSIGHTS_ENABLED ?? "false").toLowerCase() ===
    "true",

  // Notifications
  POSTMARK_SERVER_TOKEN: process.env.POSTMARK_SERVER_TOKEN,
  NOTIFICATION_FROM_EMAIL:
    process.env.NOTIFICATION_FROM_EMAIL ?? "notifications@squadpitch.com",

  // Inbox outbound email — deliberately namespaced separately from
  // NOTIFICATION_FROM_EMAIL so the system-notification path and the
  // user→lead Inbox reply path can't accidentally share each
  // other's sender or routing config. Postmark server token is
  // shared (one account); From/Reply behaviors are separate.
  POSTMARK_MESSAGE_STREAM: process.env.POSTMARK_MESSAGE_STREAM ?? "outbound",
  INBOX_EMAIL_FROM: process.env.INBOX_EMAIL_FROM,
  INBOX_EMAIL_REPLY_DOMAIN: process.env.INBOX_EMAIL_REPLY_DOMAIN,
  // Password used to authenticate Postmark's inbound webhook via
  // HTTP Basic Auth (or an injected X-Postmark-Secret header).
  POSTMARK_INBOUND_WEBHOOK_SECRET: process.env.POSTMARK_INBOUND_WEBHOOK_SECRET,
  POSTMARK_ACCOUNT_APPROVED:
    String(process.env.POSTMARK_ACCOUNT_APPROVED ?? "false").toLowerCase() ===
    "true",
  POSTMARK_SENDER_VERIFIED:
    String(process.env.POSTMARK_SENDER_VERIFIED ?? "false").toLowerCase() ===
    "true",
  POSTMARK_DELIVERY_VERIFIED:
    String(process.env.POSTMARK_DELIVERY_VERIFIED ?? "false").toLowerCase() ===
    "true",
  POSTMARK_CANARY_ACCESS_TOKEN: process.env.POSTMARK_CANARY_ACCESS_TOKEN,
  POSTMARK_CANARY_ALLOWED_WORKSPACE_ID:
    process.env.POSTMARK_CANARY_ALLOWED_WORKSPACE_ID,
  POSTMARK_CANARY_CONVERSATION_ID:
    process.env.POSTMARK_CANARY_CONVERSATION_ID,
  POSTMARK_CANARY_ALLOWED_RECIPIENT:
    process.env.POSTMARK_CANARY_ALLOWED_RECIPIENT,
  // Per-workspace daily send cap. Conservative default so a runaway
  // workspace (or a bug) can't blast a Postmark account dry.
  INBOX_EMAIL_DAILY_CAP: Number.isFinite(
    parseInt(process.env.INBOX_EMAIL_DAILY_CAP, 10),
  )
    ? parseInt(process.env.INBOX_EMAIL_DAILY_CAP, 10)
    : 50,

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID,
  // Exact public URL Twilio uses to POST inbound SMS to us.
  // Required for X-Twilio-Signature verification — the HMAC is
  // computed over (URL + sorted form params), and Fly's proxy
  // headers can make in-process URL reconstruction unreliable
  // (req.protocol, req.headers.host etc. may not reflect what
  // Twilio actually called). Default falls back to the prod URL
  // so a deploy without the secret still validates correctly in
  // production; dev/staging should override.
  TWILIO_INBOUND_WEBHOOK_URL:
    process.env.TWILIO_INBOUND_WEBHOOK_URL ??
    "https://squadpitch-api.fly.dev/api/v1/inbox/webhooks/twilio/inbound",
  TWILIO_STATUS_CALLBACK_URL:
    process.env.TWILIO_STATUS_CALLBACK_URL ??
    "https://squadpitch-api.fly.dev/api/v1/inbox/webhooks/twilio/status",
  INBOX_SMS_DAILY_CAP: Number.isFinite(
    parseInt(process.env.INBOX_SMS_DAILY_CAP, 10),
  )
    ? parseInt(process.env.INBOX_SMS_DAILY_CAP, 10)
    : 50,
  INBOX_SMS_MAX_CHARS: Number.isFinite(
    parseInt(process.env.INBOX_SMS_MAX_CHARS, 10),
  )
    ? parseInt(process.env.INBOX_SMS_MAX_CHARS, 10)
    : 480,
  // SMS sending gates. Two independently-flippable flags so the
  // workspace can hold sending back even after A2P approval lands
  // (or vice versa — flip A2P_APPROVED to acknowledge approval
  // without enabling sending, then flip SENDING_ENABLED later).
  // Both must be true for the inbox outbound SMS path to fire.
  //
  //   SMS_A2P_APPROVED       — Twilio Brand + Campaign both
  //                            APPROVED. Set this when Twilio
  //                            Console confirms approval.
  //   SMS_SENDING_ENABLED    — operational kill switch for the
  //                            inbox send path. Lets us roll
  //                            the code without enabling live
  //                            send on day one.
  //
  // Notifications-side SMS (OTPs, internal alerts) is unaffected
  // by these flags — those go through transactional channels.
  SMS_A2P_APPROVED:
    String(process.env.SMS_A2P_APPROVED ?? "false").toLowerCase() === "true",
  SMS_SENDING_ENABLED:
    String(process.env.SMS_SENDING_ENABLED ?? "false").toLowerCase() === "true",
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  APP_URL: process.env.APP_URL,

  // Google Drive (media import)
  GOOGLE_DRIVE_CLIENT_ID: process.env.GOOGLE_DRIVE_CLIENT_ID,
  GOOGLE_DRIVE_CLIENT_SECRET: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
  GOOGLE_DRIVE_REDIRECT_URI: process.env.GOOGLE_DRIVE_REDIRECT_URI,

  // Google Sheets (OAuth integration)
  GOOGLE_SHEETS_CLIENT_ID: process.env.GOOGLE_SHEETS_CLIENT_ID,
  GOOGLE_SHEETS_CLIENT_SECRET: process.env.GOOGLE_SHEETS_CLIENT_SECRET,
  GOOGLE_SHEETS_REDIRECT_URI: process.env.GOOGLE_SHEETS_REDIRECT_URI,

  // Google Business Profile
  GBP_CLIENT_ID: process.env.GBP_CLIENT_ID,
  GBP_CLIENT_SECRET: process.env.GBP_CLIENT_SECRET,
  GBP_REDIRECT_URI: process.env.GBP_REDIRECT_URI,

  // Dropbox (media import)
  DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
  DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
  DROPBOX_REDIRECT_URI: process.env.DROPBOX_REDIRECT_URI,

  // Admin

  // Global AI budget caps (cents per month)
  OPENAI_MONTHLY_BUDGET_CENTS:
    parseInt(process.env.OPENAI_MONTHLY_BUDGET_CENTS, 10) || 2000,
  FAL_MONTHLY_BUDGET_CENTS:
    parseInt(process.env.FAL_MONTHLY_BUDGET_CENTS, 10) || 1000,
  BUDGET_WARNING_THRESHOLD:
    parseFloat(process.env.BUDGET_WARNING_THRESHOLD) || 0.8,

  // Property data providers — set PROPERTY_DATA_PROVIDER to "rentcast" or "attom"
  PROPERTY_DATA_PROVIDER: process.env.PROPERTY_DATA_PROVIDER ?? "rentcast",
  PROPERTY_API_PROVIDER:
    process.env.PROPERTY_API_PROVIDER ??
    (process.env.NODE_ENV === "production" ? "rentcast" : "mock"),
  PROPERTY_ENRICHMENT_ENABLED:
    String(process.env.PROPERTY_ENRICHMENT_ENABLED ?? "true").toLowerCase() ===
    "true",
  PROPERTY_SYNTHETIC_DEMO_MODE:
    String(process.env.PROPERTY_SYNTHETIC_DEMO_MODE ?? "false").toLowerCase() ===
    "true",

  // RentCast
  RENTCAST_API_KEY: process.env.RENTCAST_API_KEY,
  RENTCAST_API_BASE:
    process.env.RENTCAST_API_BASE ?? "https://api.rentcast.io/v1",

  // ATTOM (future — set key to enable as fallback or primary)
  ATTOM_API_KEY: process.env.ATTOM_API_KEY,
  ATTOM_API_BASE:
    process.env.ATTOM_API_BASE ?? "https://api.gateway.attomdata.com",

  // Observability (all optional — code degrades gracefully if unset)
  SENTRY_DSN: process.env.SENTRY_DSN,
  SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
  SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
  SENTRY_RELEASE: process.env.SENTRY_RELEASE,
  SENTRY_DELIVERY_VERIFIED: process.env.SENTRY_DELIVERY_VERIFIED,
  WORKER_ALERT_DELIVERY_VERIFIED: process.env.WORKER_ALERT_DELIVERY_VERIFIED,
  AI_BASELINE_METADATA_ENABLED:
    String(
      process.env.AI_BASELINE_METADATA_ENABLED ?? "false",
    ).toLowerCase() === "true",
  AI_PLATFORM_INTERNAL_BASE_URL: process.env.AI_PLATFORM_INTERNAL_BASE_URL,
  AI_PLATFORM_HEALTH_TIMEOUT_MS: Number.isFinite(
    parseInt(process.env.AI_PLATFORM_HEALTH_TIMEOUT_MS, 10),
  )
    ? parseInt(process.env.AI_PLATFORM_HEALTH_TIMEOUT_MS, 10)
    : 1500,
  AI_PLATFORM_SERVICE_AUTH_KEY_ID:
    process.env.AI_PLATFORM_SERVICE_AUTH_KEY_ID ?? "primary",
  AI_PLATFORM_SERVICE_AUTH_SECRET: process.env.AI_PLATFORM_SERVICE_AUTH_SECRET,
  APP_BUILD_SHA: process.env.APP_BUILD_SHA ?? process.env.FLY_IMAGE_REF,
  AI_PROVENANCE_RESPONSE_HEADERS_ENABLED:
    String(
      process.env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED ?? "false",
    ).toLowerCase() === "true",
  AI_RETRIEVAL_ENABLED:
    String(process.env.AI_RETRIEVAL_ENABLED ?? "false").toLowerCase() ===
    "true",
  AI_CAMPAIGN_OPS_AGENT_ENABLED:
    String(
      process.env.AI_CAMPAIGN_OPS_AGENT_ENABLED ?? "false",
    ).toLowerCase() === "true",
  AI_ACTION_PROPOSALS_ENABLED:
    String(process.env.AI_ACTION_PROPOSALS_ENABLED ?? "false").toLowerCase() ===
    "true",
  AI_OPERATIONS_CENTER_ENABLED:
    String(
      process.env.AI_OPERATIONS_CENTER_ENABLED ?? "false",
    ).toLowerCase() === "true",
  AI_AUTOPILOT_ML_RANKING_ENABLED:
    String(
      process.env.AI_AUTOPILOT_ML_RANKING_ENABLED ?? "false",
    ).toLowerCase() === "true",
  AI_BRAND_QUALITY_MODEL_ENABLED:
    String(
      process.env.AI_BRAND_QUALITY_MODEL_ENABLED ?? "false",
    ).toLowerCase() === "true",
  AI_EXPERIMENTATION_ENABLED:
    String(process.env.AI_EXPERIMENTATION_ENABLED ?? "false").toLowerCase() ===
    "true",

  // Publishing reliability
  // - PUBLISH_ADAPTER_TIMEOUT_MS: hard cap on per-channel adapter calls
  //   (default 45_000). See domains/studio/publishing/publishTimeout.js.
  // - OPS_SLACK_WEBHOOK_URL: optional Slack incoming webhook for backlog/
  //   failure alerts. If unset, alerts are logged as structured JSON.
  PUBLISH_ADAPTER_TIMEOUT_MS: process.env.PUBLISH_ADAPTER_TIMEOUT_MS,
  OPS_SLACK_WEBHOOK_URL: process.env.OPS_SLACK_WEBHOOK_URL,

  // Stripe billing
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_EXPECTED_MODE: process.env.STRIPE_EXPECTED_MODE ?? "test",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_STARTER_PRICE_ID: process.env.STRIPE_STARTER_PRICE_ID,
  STRIPE_PRO_PRICE_ID: process.env.STRIPE_PRO_PRICE_ID,
  STRIPE_GROWTH_PRICE_ID: process.env.STRIPE_GROWTH_PRICE_ID,
  STRIPE_AGENCY_PRICE_ID: process.env.STRIPE_AGENCY_PRICE_ID,
  STRIPE_STARTER_PRODUCT_ID: process.env.STRIPE_STARTER_PRODUCT_ID,
  STRIPE_PRO_PRODUCT_ID: process.env.STRIPE_PRO_PRODUCT_ID,
  STRIPE_GROWTH_PRODUCT_ID: process.env.STRIPE_GROWTH_PRODUCT_ID,
};

export function bootEnvWarnings() {
  if (!env.AUTH0_DOMAIN || !env.AUTH0_AUDIENCE) {
    console.error("[BOOT] Missing AUTH0_DOMAIN or AUTH0_AUDIENCE");
  }
  if (!env.DATABASE_URL) {
    console.error("[BOOT] Missing DATABASE_URL");
  }
  if (!env.OPENAI_API_KEY) {
    console.warn(
      "[BOOT] OPENAI_API_KEY missing; generation will fail until configured",
    );
  }
  if (
    !env.META_APP_ID ||
    !env.META_APP_SECRET ||
    !env.META_OAUTH_REDIRECT_URI
  ) {
    console.warn(
      "[BOOT] META_APP_ID / META_APP_SECRET / META_OAUTH_REDIRECT_URI missing; Facebook OAuth disabled",
    );
  }
  // Instagram now uses its own Business Login app. Falls back to
  // META_* if INSTAGRAM_* isn't set (intentional migration path),
  // so this warning fires only when BOTH are missing.
  if (
    !(env.INSTAGRAM_APP_ID || env.META_APP_ID) ||
    !(env.INSTAGRAM_APP_SECRET || env.META_APP_SECRET) ||
    !(env.INSTAGRAM_OAUTH_REDIRECT_URI || env.META_OAUTH_REDIRECT_URI)
  ) {
    console.warn(
      "[BOOT] INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_OAUTH_REDIRECT_URI (or META_* fallback) missing; Instagram OAuth disabled",
    );
  }
  if (!env.OAUTH_STATE_SECRET) {
    console.warn(
      "[BOOT] OAUTH_STATE_SECRET missing; OAuth state signing disabled",
    );
  }
  if (!env.TOKEN_ENCRYPTION_KEY) {
    console.warn(
      "[BOOT] TOKEN_ENCRYPTION_KEY missing; channel connection writes will fail until configured",
    );
  }
  if (
    !env.TIKTOK_CLIENT_KEY ||
    !env.TIKTOK_CLIENT_SECRET ||
    !env.TIKTOK_REDIRECT_URI
  ) {
    console.warn("[BOOT] TikTok OAuth credentials missing");
  }
  if (
    !env.LINKEDIN_CLIENT_ID ||
    !env.LINKEDIN_CLIENT_SECRET ||
    !env.LINKEDIN_REDIRECT_URI
  ) {
    console.warn(
      "[BOOT] LinkedIn (Personal Profile) OAuth credentials missing",
    );
  }
  if (
    !env.LINKEDIN_ORG_CLIENT_ID ||
    !env.LINKEDIN_ORG_CLIENT_SECRET ||
    !env.LINKEDIN_ORG_REDIRECT_URI
  ) {
    console.warn(
      "[BOOT] LinkedIn (Organization Page) OAuth credentials missing — " +
        "Organization Page connect flow will be unavailable until configured",
    );
  }
  if (
    !env.PINTEREST_CLIENT_ID ||
    !env.PINTEREST_CLIENT_SECRET ||
    !env.PINTEREST_REDIRECT_URI
  ) {
    console.warn(
      "[BOOT] Pinterest OAuth credentials missing — Pinterest connect flow will be unavailable until configured",
    );
  }
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET || !env.X_REDIRECT_URI) {
    console.warn("[BOOT] X OAuth credentials missing");
  }
  if (
    !env.YOUTUBE_CLIENT_ID ||
    !env.YOUTUBE_CLIENT_SECRET ||
    !env.YOUTUBE_REDIRECT_URI
  ) {
    console.warn("[BOOT] YouTube OAuth credentials missing");
  }
  if (
    env.THREADS_ENABLED &&
    (!env.THREADS_APP_ID ||
      !env.THREADS_APP_SECRET ||
      !env.THREADS_REDIRECT_URI)
  ) {
    console.warn(
      "[BOOT] Threads OAuth credentials missing — Threads connect flow will fail until configured (THREADS_APP_ID / THREADS_APP_SECRET / THREADS_REDIRECT_URI)",
    );
  }
  if (
    env.THREADS_ENABLED &&
    (!env.THREADS_UNINSTALL_CALLBACK_URL || !env.THREADS_DELETE_CALLBACK_URL)
  ) {
    console.warn(
      "[BOOT] Threads webhook callback URLs missing (THREADS_UNINSTALL_CALLBACK_URL / THREADS_DELETE_CALLBACK_URL); Meta requires both",
    );
  }
  if (!env.STRIPE_SECRET_KEY) {
    console.warn("[BOOT] STRIPE_SECRET_KEY missing; billing features disabled");
  } else {
    // Defer to billing.constants for the per-tier price-id check so we
    // get a single warning that names every missing var.
    assertStripeEnvConfigured(env);
  }
  if (!env.RENTCAST_API_KEY) {
    console.warn(
      "[BOOT] RENTCAST_API_KEY missing; property data lookups will fail",
    );
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn("[BOOT] VAPID keys missing; web push notifications disabled");
  }
}
