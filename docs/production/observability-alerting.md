# Production Observability and Launch Alerts

This is the launch dashboard specification and incident runbook. Repository
instrumentation does not prove that Sentry, Fly, Stripe, Postmark, Twilio, Auth0
or provider-side alerts are configured. Alert credentials belong only in the
provider secret store.

## Current audit

| Surface | Current signal | Launch requirement |
| --- | --- | --- |
| Web | Browser Sentry, global error capture, API proxy responses | Production environment/release tags, source maps, auth-flow and proxy-error alerts |
| API | Pino JSON, request IDs, safe request/workspace context, Sentry 5xx capture | Sentry DSN/environment/release; log-derived metrics for the alert catalog |
| AI service | Structured execution provenance, trace IDs, health/readiness and fallback fields | Central log ingestion, hosted error/latency and fallback-rate alerts |
| Postgres | API readiness and system-health queries | Provider CPU/storage/connections alerts plus query-error log alert |
| Redis/BullMQ | Redis health, queue counts and worker failure logs | Persistence/eviction monitoring, oldest-job and worker-stopped alerts |
| Webhooks | Signature checks, provider event IDs and database idempotency/order guards | Failure/retry/silence alerts per provider |
| Publishing | Draft status, publish attempts, provider errors and audit events | Failure ratio by provider/channel; stale scheduled-post alert |
| Billing | Stripe signature verification, event ordering markers and billing health | Checkout and webhook alerts; Stripe Workbench delivery alerts |
| Email/SMS | Postmark/Twilio provider errors and delivery state | Send failure, delivery callback and signature-failure alerts |
| OAuth | Signed state, token refresh and `NEEDS_RECONNECT` state | Refresh failure/connection degradation grouped by provider |

No logs or error contexts may contain Authorization/Cookie headers, access or
refresh tokens, secrets, message bodies, generated content, customer email,
phone number, or full webhook payloads. Safe correlation fields are:
`requestId`, `traceId`, opaque `workspaceId`/`clientId`, provider, channel,
operation, error code, HTTP status, attempt, duration, service version and
environment. Avoid Auth0 subject unless an access-controlled investigation
requires it.

## Health and readiness

- `GET /health` is liveness only: the API process can answer HTTP. It does not
  touch dependencies and returns 200.
- `GET /ready` is traffic readiness: it checks Postgres and Redis read-only,
  returning 503 with boolean dependency status when unavailable.
- Fly's API service check currently targets liveness-only `/health`, so a
  database or Redis outage does not remove every API machine from service.
  `/ready` is available and checks Postgres, Redis, and worker heartbeat state,
  but no independently verified external monitor currently polls it. Add an
  external `/ready` monitor while retaining Fly's `/health` process check so
  responders can distinguish dependency failure from process death.
- AI health/readiness must retain the same distinction. Do not make liveness
  depend on a model vendor.

## Launch dashboard

Build one dashboard with environment=`production` fixed and a selectable
15-minute/1-hour/24-hour range:

1. Request volume, 2xx/4xx/5xx rate, p50/p95/p99 latency by service and route
   family; never use raw URLs containing IDs as dimensions.
2. Auth 401/403 rate and callback failures.
3. Postgres readiness, query errors, connections, CPU, storage and latency.
4. Redis readiness, memory/evictions, BullMQ waiting/active/delayed/failed counts,
   oldest eligible job age and worker heartbeat.
5. Publish attempts/success/failure and latency by provider/channel.
6. Stripe checkout success/failure and webhook received/processed/rejected age.
7. Postmark sends/failures/inbound failures; Twilio sends and
   delivered/failed/undelivered callback counts.
8. OAuth connect/refresh success/failure and `NEEDS_RECONNECT` transitions by
   provider.
9. Hosted AI calls, failures, timeout/latency, source=`squadpitch-ai`,
   `fallbackUsed`, fallback layer and fallback reason.
10. Current deploy release, machine count/restarts and active incident links.

## Alert catalog

The source-controlled catalog is validated by `npm run verify:observability`.
Tune thresholds only after collecting a baseline; never weaken P0/P1 alerts
without an owner and expiry.

| Alert | Severity | Initial trigger |
| --- | --- | --- |
| API 5xx spike | P1 | >2% for 5m and at least 50 requests |
| Auth failures | P1 | 401/403 >3x seven-day baseline for 10m |
| Stripe checkout | P1 | 5 failures in 10m or any live/test mismatch |
| Stripe webhook | P1 | 3 failures in 10m or oldest retry >15m |
| Queue/worker | P1 | worker stopped, failed spike, or oldest eligible job >10m |
| Publish failures | P1 | 5 failures or >10% in 15m, grouped by provider |
| Database unavailable | P0 | readiness DB check fails for two consecutive minutes |
| Postmark | P1 | 5 send failures in 10m or unexpected inbound silence |
| Twilio | P1 | 5 failed/undelivered callbacks in 10m or signature failures |
| OAuth refresh | P1 | 5 reconnect transitions/provider in 15m |
| Hosted AI outage | P1 | readiness fails or errors >5% for 5m |
| AI fallback | P1 | fallback >5% for 15m or any forbidden fallback |

Every alert needs owner, Slack/PagerDuty destination, dashboard link, runbook
link, dedup key, environment filter, minimum-volume guard, recovery threshold
and test evidence. Page P0 immediately. Page P1 during launch coverage; after
launch, page only user-impacting P1s and ticket P2s.

## Response runbook

1. Acknowledge, name an incident commander and record first-failure time,
   environment, release, request/trace IDs and affected provider/workspaces.
2. Confirm impact using two independent signals. Check recent deploys before
   blaming a provider.
3. Contain: pause the affected worker/provider path or rollback the release.
   Do not disable idempotency, signature verification or tenant checks.
4. For queues, stop consumers before replay and inspect oldest/failed jobs.
   Requeue only allowlisted jobs with stable idempotency keys.
5. For Stripe, treat Stripe as authoritative and replay events oldest-first.
   For publishing/email/SMS, verify provider state before retrying to prevent
   duplicates.
6. For OAuth refresh spikes, stop automated retries that amplify rate limits,
   retain `NEEDS_RECONNECT`, and examine provider status/config changes.
7. For AI outage/fallback, confirm hosted source, operation, timeout and
   fallback policy. Disable the feature if a no-fallback operation cannot use
   hosted AI.
8. Validate recovery for two full alert windows, annotate the dashboard and
   preserve safe evidence. File follow-up owners and deadlines.

## Exact manual setup

### Sentry

1. Create separate production projects for `squadpitch-web` and
   `squadpitch-api`; set each project platform and production environment.
2. Store the API DSN as Fly `SENTRY_DSN`; set `SENTRY_ENVIRONMENT=production`
   and an intentional `SENTRY_TRACES_SAMPLE_RATE`. Store the web public DSN as
   `NEXT_PUBLIC_SENTRY_DSN` at build time with
   `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`.
3. Configure release identifiers from the Git commit SHA for both services and
   upload web source maps using a scoped Sentry auth token in CI. Do not expose
   that token as `NEXT_PUBLIC_*`.
4. Add issue alerts for new/regressed production errors, 5xx volume, auth-flow
   failures, Stripe failures and provider failure tags. Add metric alerts for
   error ratio and latency. Route P0/P1 to the launch channel/on-call.
5. Add data scrubbing for Authorization, Cookie, tokens, secrets, email, phone,
   request bodies and webhook payloads. Send test events from production-like
   staging and verify release/environment tags and symbolication.

### Fly and datastore providers

1. In Fly, keep `/health` as the API process check and add an independent
   external `/ready` dependency monitor. Create log-derived metrics for the
   event names in the catalog and a machine restart/crash alert. The web app
   and both worker apps also need independently verified process/heartbeat
   monitors because they currently have no Fly service checks.
2. Configure Postgres alerts for availability, connections, CPU, storage and
   sustained latency. Configure Redis alerts for availability, memory,
   evictions and persistence failures.
3. Route logs from web/API/AI to the chosen central destination with JSON
   parsing and retention appropriate for security/audit needs. Verify
   `requestId`/`traceId` search across services.

### Provider dashboards

1. Stripe Workbench: verify the live webhook endpoint, alert on failed delivery,
   and grant least-privilege event replay access.
2. Auth0: enable tenant logs/log streaming and anomaly/brute-force alerts;
   monitor failed login, callback and breached-password events.
3. Postmark: configure bounce/spam/inactive-recipient alerts and inbound webhook
   delivery monitoring.
4. Twilio: configure Messaging Insights/Debugger alerts for failed and
   undelivered messages plus webhook errors.
5. Meta, LinkedIn, Google/YouTube, TikTok, Pinterest, X and Threads: set provider
   developer-dashboard contacts, webhook/app-status notifications, quota alerts
   where offered, and subscribe the launch owner to app-review/status notices.

Record screenshots or exported configurations, alert IDs, owners, test
timestamps and delivery evidence in the launch change record. The repository
must not claim those manual steps are complete without that evidence.
