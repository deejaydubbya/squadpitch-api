# Production readiness verifier

Run from `squadpitch-api`:

```bash
npm run verify:production
npm run verify:production:json
npm run verify:production:no-network
```

The verifier never reports secret values. It distinguishes configuration checks
from live connectivity checks and reports `PASS`, `WARN`, `BLOCKED`, or `FAIL`.
Only P0 `FAIL` results make the process exit nonzero. `--no-network` performs
configuration and dangerous-flag checks while marking live probes `BLOCKED`.

## Checks and remediation

| Group                | Configuration                            | Live check                            | Failure policy / remediation                                                      |
| -------------------- | ---------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| Runtime/environment  | `NODE_ENV`, application URLs             | API and web HTTP                      | Production runtime failures are P0; repair Fly/web deployment and canonical URLs. |
| Auth0                | Domain and audience                      | OIDC discovery                        | P0; correct tenant/audience and dashboard application/API settings.               |
| Stripe               | Live key, webhook secret, four price IDs | Authenticated price lookup            | P0; configure live-mode products/prices and webhook signing.                      |
| Postmark/email       | Server token and verified sender         | Authenticated server lookup           | Optional WARN until email is enabled; verify sender/domain manually.              |
| Twilio/SMS           | SID, token, from number                  | Authenticated account lookup          | WARN while disabled; P0 if sending is enabled. Never enable automatically.        |
| Database             | `DATABASE_URL`                           | `SELECT 1`                            | P0; restore PostgreSQL access.                                                    |
| Migration/schema     | n/a                                      | unfinished `_prisma_migrations` query | P0; resolve failed or unfinished migrations.                                      |
| Redis/queues/workers | `REDIS_URL`                              | Redis `PING`                          | P0; restore shared Redis and separately inspect worker machines/logs.             |
| Hosted AI            | private URL and signing key/secret       | AI health endpoint                    | P0; then run `npm run verify:ai-production` for signed operation provenance.      |
| Sentry               | API DSN/environment                      | Manual event confirmation             | Optional WARN; dashboard ingestion must be verified manually.                     |
| Social integrations  | complete credential/redirect triplets    | Manual OAuth/publish checks           | Partial providers WARN; verify callbacks/scopes in each provider dashboard.       |
| Sites runtime        | domain, revalidation URL/token, IP salt  | `/api/health`                         | P0; repair SquadSites deployment or shared revalidation configuration.            |
| Dangerous flags      | SMS/A2P and Pinterest sandbox            | n/a                                   | SMS without A2P is P0; sandbox mode WARN.                                         |

## Manual dashboard work

- Auth0: confirm production callback/logout/origin URLs and API audience.
- Stripe: confirm live-mode webhook delivery and price/product mapping.
- Postmark: confirm sender/domain verification and inbound webhook secret.
- Twilio: confirm A2P approval, messaging service/from number, and webhook URLs.
- Sentry: send and locate one release-tagged API event and one web event.
- Social providers: confirm production redirect URIs, permissions/app-review state,
  webhook subscriptions, and token lifecycle.
- Fly: confirm API, worker, AI, web, and sites machine health and restart policy.

## Known startup gaps

`config/env.js` currently logs several missing variables instead of stopping the
process. In particular, missing Auth0, database, Stripe, Redis/worker, hosted-AI,
sites revalidation, and enabled-provider configuration can allow a process to
start while major product paths remain unusable. This verifier is a release gate;
it does not silently change startup behavior or credentials.
