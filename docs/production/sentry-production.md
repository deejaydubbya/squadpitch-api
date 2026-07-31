# Sentry production setup

Use three Sentry projects so ownership, alerts, releases, and sampling remain service-specific:

| Project | Platform | Runtime targets |
| --- | --- | --- |
| Squadpitch Web | Next.js | `squadpitch-web` |
| Squadpitch API | Node.js / Express | `squadpitch-api` |
| Squadpitch AI | Python / FastAPI | `squadpitch-ai`, `squadpitch-ai-worker` |

## Configuration

Never place DSNs or auth tokens in tracked files. DSNs are project identifiers rather than authentication credentials, but they should still be managed as configuration.

### Web

- `SENTRY_DSN`: server/route-handler runtime configuration; set on `squadpitch-web`.
- `SENTRY_ENVIRONMENT=production`: runtime configuration; set on `squadpitch-web`.
- `SENTRY_RELEASE`: optional runtime release; Fly image metadata is the fallback.
- `NEXT_PUBLIC_SENTRY_DSN`: safe public DSN, required at **build time** for browser events.
- `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`: build-time public environment.
- `NEXT_PUBLIC_SENTRY_RELEASE`: build-time Git SHA.
- `SENTRY_AUTH_TOKEN`: scoped source-map upload credential, build/CI only. Never set it as a Fly runtime secret or expose it as `NEXT_PUBLIC_*`.
- `SENTRY_ORG` and `SENTRY_PROJECT`: source-map upload coordinates (`Squadpitch Web` project).

The Next.js SDK uploads source maps only when its build-time upload variables exist. Store the auth token in the GitHub production environment and pass it to a BuildKit secret when enabling uploads; do not use a Docker `ARG` for the token.

### API

Set on `squadpitch-api`: `SENTRY_DSN`, `SENTRY_ENVIRONMENT=production`, `SENTRY_TRACES_SAMPLE_RATE=0.05`, and optionally `SENTRY_RELEASE`. Set `SENTRY_DELIVERY_VERIFIED` only after locating a synthetic event in the dashboard.

### AI

Set the same dedicated AI project DSN on both `squadpitch-ai` and `squadpitch-ai-worker` as `SP_AI_SENTRY_DSN`. Also set `SP_AI_SENTRY_ENVIRONMENT=production` and `SP_AI_SENTRY_TRACES_SAMPLE_RATE=0`. OTel owns AI tracing, so Sentry trace sampling remains disabled to avoid duplicates. `SP_AI_SENTRY_RELEASE` is optional because the build SHA/Fly image is the fallback. Record dashboard confirmation in `SP_AI_SENTRY_DELIVERY_VERIFIED`.

## Delivery verification

Run from an operator shell with the relevant runtime DSN injected without echoing it:

```text
# Web
npm run verify:sentry

# API
npm run verify:sentry

# AI
uv run squadpitch-ai-sentry-verify
```

Each command emits one harmless exception tagged `synthetic=true` and `source=production-readiness`, flushes the SDK, and prints only its event ID. Search the matching production project for that ID. Configuration and delivery are separate states: an installed DSN is `CONFIGURED`; only a located event is `DELIVERY_VERIFIED`.

## Privacy controls

All services disable default PII. Event processors remove headers, cookies, request bodies, email/phone/message/content fields, passwords, API keys, OAuth/access tokens, and secrets. Safe diagnostic dimensions may include service, environment, release, request/trace ID, workspace ID, route, provider, operation, and status. Do not attach customer-created content to manual capture calls.

## Beta alert rules

Create production-only issue/metric alerts and route them to the beta on-call destination:

- Web regression: new issue immediately, or at least 3 error events in 10 minutes.
- API 5xx spike: at least 3 events in 5 minutes, excluding expected 4xx responses.
- AI error spike: at least 3 events in 10 minutes, grouped by operation/provider.
- Stripe webhook failure: any production failure; escalate if 2 occur in 15 minutes.
- Publishing failure: any permanent failure, or 3 retryable failures in 15 minutes.
- Queue/worker failure: any crashed job/worker, or 3 failed jobs in 10 minutes.

Notify once per issue with a 30-minute action interval to avoid alert storms. Filter all rules to `environment:production`; keep synthetic verification events out of paging rules with `synthetic:false`.
