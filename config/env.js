import "dotenv/config";

export const env = {
  PORT: process.env.PORT ?? "8080",
  AUTH0_DOMAIN: process.env.AUTH0_DOMAIN,
  AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV ?? "production",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,

  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,

  REDIS_URL: process.env.REDIS_URL,

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

  // Meta / Instagram / Facebook OAuth
  META_APP_ID: process.env.META_APP_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_OAUTH_REDIRECT_URI: process.env.META_OAUTH_REDIRECT_URI,

  // OAuth state signing (HMAC secret, random 32+ bytes)
  OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,

  // Token encryption (base64-encoded 32 bytes for AES-256-GCM)
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,

  // TikTok
  TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY,
  TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET,
  TIKTOK_REDIRECT_URI: process.env.TIKTOK_REDIRECT_URI,

  // LinkedIn
  LINKEDIN_CLIENT_ID: process.env.LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET: process.env.LINKEDIN_CLIENT_SECRET,
  LINKEDIN_REDIRECT_URI: process.env.LINKEDIN_REDIRECT_URI,

  // X (Twitter)
  X_CLIENT_ID: process.env.X_CLIENT_ID,
  X_CLIENT_SECRET: process.env.X_CLIENT_SECRET,
  X_REDIRECT_URI: process.env.X_REDIRECT_URI,

  // YouTube (Google)
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI,

  // Notifications
  POSTMARK_SERVER_TOKEN: process.env.POSTMARK_SERVER_TOKEN,
  NOTIFICATION_FROM_EMAIL: process.env.NOTIFICATION_FROM_EMAIL ?? "notifications@squadpitch.com",
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  APP_URL: process.env.APP_URL ?? "https://squadpitch-web.fly.dev",

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
  ADMIN_USER_IDS: process.env.ADMIN_USER_IDS ?? "",

  // Global AI budget caps (cents per month)
  OPENAI_MONTHLY_BUDGET_CENTS: parseInt(process.env.OPENAI_MONTHLY_BUDGET_CENTS, 10) || 2000,
  FAL_MONTHLY_BUDGET_CENTS: parseInt(process.env.FAL_MONTHLY_BUDGET_CENTS, 10) || 1000,
  BUDGET_WARNING_THRESHOLD: parseFloat(process.env.BUDGET_WARNING_THRESHOLD) || 0.8,

  // Property data providers — set PROPERTY_DATA_PROVIDER to "rentcast" or "attom"
  PROPERTY_DATA_PROVIDER: process.env.PROPERTY_DATA_PROVIDER ?? "rentcast",

  // RentCast
  RENTCAST_API_KEY: process.env.RENTCAST_API_KEY,
  RENTCAST_API_BASE: process.env.RENTCAST_API_BASE ?? "https://api.rentcast.io/v1",

  // ATTOM (future — set key to enable as fallback or primary)
  ATTOM_API_KEY: process.env.ATTOM_API_KEY,
  ATTOM_API_BASE: process.env.ATTOM_API_BASE ?? "https://api.gateway.attomdata.com",

  // Stripe billing
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_STARTER_PRICE_ID: process.env.STRIPE_STARTER_PRICE_ID,
  STRIPE_PRO_PRICE_ID: process.env.STRIPE_PRO_PRICE_ID,
  STRIPE_GROWTH_PRICE_ID: process.env.STRIPE_GROWTH_PRICE_ID,
  STRIPE_AGENCY_PRICE_ID: process.env.STRIPE_AGENCY_PRICE_ID,
};

export function bootEnvWarnings() {
  if (!env.AUTH0_DOMAIN || !env.AUTH0_AUDIENCE) {
    console.error("[BOOT] Missing AUTH0_DOMAIN or AUTH0_AUDIENCE");
  }
  if (!env.DATABASE_URL) {
    console.error("[BOOT] Missing DATABASE_URL");
  }
  if (!env.OPENAI_API_KEY) {
    console.warn("[BOOT] OPENAI_API_KEY missing; generation will fail until configured");
  }
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_OAUTH_REDIRECT_URI) {
    console.warn("[BOOT] META_APP_ID / META_APP_SECRET / META_OAUTH_REDIRECT_URI missing; Instagram OAuth disabled");
  }
  if (!env.OAUTH_STATE_SECRET) {
    console.warn("[BOOT] OAUTH_STATE_SECRET missing; OAuth state signing disabled");
  }
  if (!env.TOKEN_ENCRYPTION_KEY) {
    console.warn("[BOOT] TOKEN_ENCRYPTION_KEY missing; channel connection writes will fail until configured");
  }
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET || !env.TIKTOK_REDIRECT_URI) {
    console.warn("[BOOT] TikTok OAuth credentials missing");
  }
  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET || !env.LINKEDIN_REDIRECT_URI) {
    console.warn("[BOOT] LinkedIn OAuth credentials missing");
  }
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET || !env.X_REDIRECT_URI) {
    console.warn("[BOOT] X OAuth credentials missing");
  }
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REDIRECT_URI) {
    console.warn("[BOOT] YouTube OAuth credentials missing");
  }
  if (!env.STRIPE_SECRET_KEY) {
    console.warn("[BOOT] STRIPE_SECRET_KEY missing; billing features disabled");
  }
  if (!env.RENTCAST_API_KEY) {
    console.warn("[BOOT] RENTCAST_API_KEY missing; property data lookups will fail");
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn("[BOOT] VAPID keys missing; web push notifications disabled");
  }
}
