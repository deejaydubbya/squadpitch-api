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

  // Fal.ai — image/video generation
  FAL_API_KEY: process.env.FAL_API_KEY,
  FAL_DEFAULT_MODEL: process.env.FAL_DEFAULT_MODEL ?? "fal-ai/flux/dev",

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
  APP_URL: process.env.APP_URL ?? "https://squadpitch-web.fly.dev",

  // Stripe billing
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_STARTER_PRICE_ID: process.env.STRIPE_STARTER_PRICE_ID,
  STRIPE_GROWTH_PRICE_ID: process.env.STRIPE_GROWTH_PRICE_ID,
  STRIPE_PRO_PRICE_ID: process.env.STRIPE_PRO_PRICE_ID,
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
}
