# Worker health monitoring

Squadpitch monitors two production worker surfaces without inspecting job
payloads:

- `squadpitch-api` owns the BullMQ consumers. A dedicated
  `sp-worker-health` consumer proves enqueue, processing, correlation, and
  removal using only `[SYNTHETIC CANARY] worker-health` jobs.
- `squadpitch-ai-worker` writes a bounded Redis heartbeat. It currently hosts
  the Python worker process but does not consume BullMQ jobs.

## Heartbeats

Each worker instance writes a JSON heartbeat containing only timestamp,
service, Fly machine/host identifier, release, and status. The value expires
after 360 seconds. A sorted set tracks active instance identifiers and is
pruned on every heartbeat, so scaling cannot create unbounded keys.

Heartbeats are written every 30 seconds and become stale after five minutes.
Healthy status requires fresh heartbeats from both `api-worker` and
`squadpitch-ai-worker`; process existence alone is insufficient.

## Queues and thresholds

Aggregate inspection covers:

- `sp-media-gen`
- `sp-video-gen`
- `sp-persona-training`
- `sp-notification`
- `sp-metrics-sync`
- `sp-analytics-recalc`
- `sp-insights-refresh`
- `sp-scheduled-publish`
- `sp-weekly-digest`
- `sp-gbp-review-poll`
- `sp-worker-health`

Low-beta thresholds:

| Signal | Warning | Critical |
| --- | ---: | ---: |
| Heartbeat age | — | over 5 minutes |
| Waiting backlog | 25 jobs | 100 jobs |
| Oldest waiting job | over 5 minutes | over 15 minutes |
| Failed jobs in 15 minutes | 3 | 10 |
| Stalled jobs in 15 minutes | any | repeated/operator escalation |
| Retry exhaustion in 15 minutes | any | repeated/operator escalation |

Delayed counts and oldest delayed age are reported but do not alert because
scheduled publishing and polling legitimately use delayed jobs. Revisit these
thresholds after sufficient controlled-beta traffic exists.

## Endpoints and commands

Public `/health` remains process liveness only. Public `/ready` adds only the
coarse worker state (`healthy`, `degraded`, or `blocked`) and does not expose
queue names, counts, job identifiers, or payloads. Detailed aggregate evidence
is returned only through the authenticated, exact-workspace production canary.

With a short-lived normal synthetic-user session configured locally:

```text
npm run verify:worker-health
npm run verify:worker-health:json
npm run verify:worker-roundtrip
```

To emit one safe synthetic Sentry event from a configured production runtime:

```text
npm run verify:worker-alert
```

That command prints only PASS/FAIL and the event ID. It never creates a failed
job or pauses a worker.

## Sentry policy

Worker incidents use `source=worker-health`, safe service/queue/job-type tags,
release, severity, and a stable fingerprint. No payload, content, address,
token, request body, or customer identifier is included. Redis cooldown keys
deduplicate an incident category/queue for 15 minutes. A missing/stale
heartbeat, Redis error, backlog, job age, failure rate, stall, or retry
exhaustion emits at most one grouped incident per cooldown.

Recommended manual alert rule if the existing project-wide email alert does
not cover it:

- Name: `Production worker health`
- Project: Squadpitch API
- Environment: `production`
- Filter: `source:worker-health synthetic:false`
- Trigger: first event, then no more than once every 15 minutes
- Action: existing production email notification target

Keep `WORKER_ALERT_DELIVERY_VERIFIED` at WARN until the synthetic event and its
email notification are confirmed in Sentry.
