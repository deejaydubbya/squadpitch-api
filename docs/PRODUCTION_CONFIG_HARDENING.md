# Production configuration hardening

The API, web runtime, and hosted AI service now reject missing or unsafe core
production configuration. No credentials are stored in this repository.

## Classification

### Blockers fixed

- The web Fly build embedded `NEXT_PUBLIC_META_APP_REVIEW_DEMO=true`. The normal
  production artifact now hard-disables the reviewer UI.
- The API treated an unspecified `NODE_ENV` as production. It now defaults to
  development; Fly continues to set production explicitly.
- The API logged and continued when core Auth0, database, Redis, billing,
  Postmark, hosted AI, Sites, crypto, media-storage, URL, or worker settings
  were absent. Production boot now fails with variable names only.
- Production CORS could fall back to a list containing localhost. Production
  now requires an explicit HTTPS-only `ALLOWED_ORIGINS`.
- Production could start with Pinterest sandbox publishing or SMS sending
  enabled before A2P approval. Both states now fail boot.
- The web proxy and Auth0 callback silently used localhost when production
  server URLs were absent. Production requests now fail closed.
- The onboarding post card displayed a nonfunctional upload action. It is
  hidden until the upload journey is implemented.
- The hosted AI Fly app identified itself as staging and accepted missing
  database, Redis, and service-auth settings. It now identifies as production
  and validates all three at startup.

### Safe warnings

- Sentry remains optional and emits an availability warning.
- `OPENAI_API_KEY` remains optional for the explicit Node fallback because the
  hosted AI path is the production core.
- Individual social providers, Twilio while SMS is disabled, RentCast, VAPID,
  and other feature-scoped integrations continue to warn or reject their own
  actions rather than taking down unrelated core journeys.
- Meta polling and autopilot schedulers remain default-off operational gates.

### Intentional

- Localhost values in examples, tests, SSRF-denial lists, and development-only
  fallbacks are retained.
- Listing simulator routes are retained because the API rejects them in
  production.
- Deterministic AI fallback/provenance fields are retained for resilience and
  truthful execution reporting.
- Sites uses `squadpitchsites.com` as its checked-in Fly public-domain setting;
  the API must still receive the matching value explicitly.

## Fly configuration

Before deploying, set the missing values using the existing secret values from
the approved password manager or provider dashboards. Do not paste values into
source control:

```powershell
fly secrets set -a squadpitch-api `
  AUTH0_DOMAIN=... AUTH0_AUDIENCE=... DATABASE_URL=... REDIS_URL=... `
  ALLOWED_ORIGINS=https://app.squadpitch.com APP_URL=https://app.squadpitch.com `
  OAUTH_STATE_SECRET=... TOKEN_ENCRYPTION_KEY=... `
  CLOUDINARY_CLOUD_NAME=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... `
  STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... `
  STRIPE_STARTER_PRICE_ID=... STRIPE_PRO_PRICE_ID=... `
  STRIPE_GROWTH_PRICE_ID=... `
  STRIPE_STARTER_PRODUCT_ID=... STRIPE_PRO_PRODUCT_ID=... `
  STRIPE_GROWTH_PRODUCT_ID=... `
  POSTMARK_SERVER_TOKEN=... `
  AI_PLATFORM_INTERNAL_BASE_URL=... AI_PLATFORM_SERVICE_AUTH_KEY_ID=... `
  AI_PLATFORM_SERVICE_AUTH_SECRET=... `
  PUBLIC_SITES_BASE_DOMAIN=squadpitchsites.com `
  RUNTIME_REVALIDATE_URL=https://squadpitch-sites.fly.dev/api/revalidate `
  RUNTIME_REVALIDATE_TOKEN=... RUNTIME_IP_SALT=...

fly secrets set -a squadpitch-web `
  APP_BASE_URL=https://app.squadpitch.com `
  SQUADPITCH_API_URL=https://squadpitch-api.fly.dev

fly secrets set -a squadpitch-ai `
  SP_AI_POSTGRES_DSN=... SP_AI_REDIS_URL=... `
  SP_AI_SERVICE_AUTH_SECRETS=primary:...
```

The API and AI service-auth values must describe the same key ID and secret.
Keep `PINTEREST_USE_SANDBOX=false`, and do not enable `SMS_SENDING_ENABLED`
until `SMS_A2P_APPROVED=true`.

Verify the secret names without printing their values:

```powershell
fly secrets list -a squadpitch-api
fly secrets list -a squadpitch-web
fly secrets list -a squadpitch-ai
```

Then run `npm run verify:production` from `squadpitch-api`.
