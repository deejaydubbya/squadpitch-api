# Redis and BullMQ command audit

Date: 2026-08-03. Scope: `squadpitch-api`, `squadpitch-web`,
`squadpitch-sites`, `squadpitch-ai`, and `squadpitch-ai-worker`.

## Executive finding

The production API had two running Fly Machines. Each HTTP process evaluated
`ENABLE_WORKERS=true` and started the entire set of 17 BullMQ workers. Thus 34
blocking workers, two heartbeat loops, and duplicate recurring-registration
attempts existed before customer traffic. This is the primary confirmed
architectural cause of unnecessary idle traffic. The AI API also constructed a
new Redis client on every 30-second readiness probe. The AI worker wrote three
heartbeat commands every 30 seconds.

The corrected topology has producer-only API replicas and exactly one dedicated
`worker` process group. Worker initialization is role-checked and process-local
idempotent. The AI API reuses one client and caches readiness for 60 seconds.
API readiness caches its minimal dependency result for 60 seconds and no longer
enumerates all queues. Heartbeats run every 120 seconds with a 600-second TTL.

## Production startup topology

| Fly app/process | Count observed | Startup | Redis behavior before change | Corrected ownership |
|---|---:|---|---|---|
| `squadpitch-api` HTTP | 2 | `server.js` | Shared client plus all 17 workers per replica | Producers, cache/locks, and cached readiness only |
| `squadpitch-api` worker | 0 distinct | none | Work was embedded in HTTP | One `worker.js` process group owns all consumers/schedules |
| `squadpitch-web` | 2 machines, 1 started at inspection | Next standalone server | None | None |
| `squadpitch-sites` | 2 | Next standalone server | None; its API-side form limiter is in `squadpitch-api` | None |
| `squadpitch-ai` | 1 | Python FastAPI | New Redis connection + PING + close per `/ready` | Shared client, one PING per 60-second cache window |
| `squadpitch-ai-worker` | 1 | Python worker | Three heartbeat writes/30 seconds | Three writes/120 seconds |

Fly liveness is Redis-free: API `/health` is checked every 30 seconds, AI
`/health` every 15 seconds. AI `/ready` is checked every 30 seconds. API
`/ready` is used by operator/external worker-health verification, not its Fly
liveness check.

## Complete component inventory

`Continuous` describes idle production behavior. BullMQ workers use blocking
reads rather than application polling. Line numbers are stable audit anchors and
may move with later edits.

| Location | Component / namespace | Started by | Production / continuous behavior | Duplication before fix | Classification |
|---|---|---|---|---|---|
| `redis.js:6` | Shared ioredis client; arbitrary `sp:*` keys | API and worker helpers | Lazy, reused; direct GET/SET/DEL/PING | One per process | Required |
| `redis.js:48` | BullMQ connection factory | Queue/worker constructors | One connection per constructor; worker connections block | Every API replica | Required; suspicious before role split |
| `lib/queues.js:9-246` | Producer Queues: `sp-media-gen`, `sp-notification`, `sp-metrics-sync`, `sp-analytics-recalc`, `sp-insights-refresh`, `sp-video-gen`, `sp-persona-training`, `sp-scheduled-publish`, `sp-gbp-review-poll`, `sp-weekly-digest` | API request/domain producers; operator inspector | Lazy singleton; commands only when used | One singleton set per API replica | Required |
| `workers/mediaGenWorker.js:1591` | Worker `sp-media-gen` | worker process | Blocking; concurrency 2 | 2 copies before | Required |
| `workers/videoGenWorker.js:152` | Worker `sp-video-gen` | worker process | Blocking; concurrency 1 | 2 copies before | Required |
| `workers/notificationWorker.js:510` | Worker `sp-notification` | worker process | Blocking; concurrency 5 | 2 copies before | Required |
| `workers/personaTrainingWorker.js:201` | Worker `sp-persona-training` | worker process | Blocking; concurrency 1, rate limited | 2 copies before | Required |
| `workers/scheduledPublishWorker.js:304` | Worker + repeat `sp-scheduled-publish` | worker scheduler owner | Blocking; repeat every minute | 2 workers and registrations before | Required, command-heavy cadence |
| `workers/metricsSyncWorker.js:173` | Worker + repeat `sp-metrics-sync` | worker scheduler owner | Blocking; configured poll cadence | 2 before | Required |
| `workers/recalculateAnalyticsWorker.js:61` | Worker + repeat `sp-analytics-recalc` | worker scheduler owner | Blocking; configured cadence | 2 before | Required |
| `workers/refreshInsightsWorker.js:47` | Worker + repeat `sp-insights-refresh` | worker scheduler owner | Blocking; configured cadence | 2 before | Required |
| `workers/weeklyDigestWorker.js:141` | Worker + weekly repeat `sp-weekly-digest` | worker scheduler owner | Blocking; weekly schedule | 2 before | Required |
| `workers/gbpReviewPollerWorker.js:19` | Worker + 10-minute repeat `sp-gbp-review-poll` | worker scheduler owner | Blocking | 2 before | Required beta integration |
| `workers/youtubeCommentPollerWorker.js:20` | Worker + 15-minute repeat `sp-youtube-comment-poll` | worker scheduler owner | Blocking | 2 before | Required beta integration |
| `workers/threadsReplyPollerWorker.js:20` | Worker + 15-minute repeat `sp-threads-reply-poll` | worker scheduler owner | Blocking | 2 before | Required beta integration |
| `workers/facebookCommentPollerWorker.js:30` | Worker + gated repeat `sp-facebook-comments-poll` | worker scheduler owner | Worker blocks even if repeat disabled | 2 before | Required for manual sync; optional schedule |
| `workers/instagramCommentPollerWorker.js:30` | Worker + gated repeat `sp-instagram-comments-poll` | worker scheduler owner | Worker blocks even if repeat disabled | 2 before | Required for manual sync; optional schedule |
| `workers/autopilotEvaluatorWorker.js:25` | Worker + gated repeat `sp-autopilot-evaluator` | worker scheduler owner | Disabled entirely by feature flag or blocking | 2 before when enabled | Optional |
| `workers/contactRetentionWorker.js:8` | Worker + daily repeat `sp-contact-retention`; `sp:lock:contact-retention` | worker scheduler owner | Blocking; daily; distributed overlap lock | 2 before | Required |
| `domains/workerHealth/workerHealth.service.js:25` | Worker `sp-worker-health`; `sp:worker-health:*` | worker process | Blocking plus 3-command heartbeat/120 seconds | 2 workers + heartbeats before | Required |
| same file `runWorkerHealthRoundTrip` | Queue + QueueEvents `sp-worker-health` | explicit verifier/canary | On demand only; closes all resources | None continuously | Required operator diagnostic |
| same file `inspectWorkerHealth` | All queue counts/history | explicit operator diagnostic | Many commands per invocation; no continuous loop | Previously called by readiness | Required but expensive; removed from readiness |
| same file `inspectWorkerReadiness` | Heartbeat keys only | cached API `/ready` | Two sorted-set reads plus heartbeat GETs per cache miss | Per API replica | Required/minimized |
| `domains/canary/canary.service.js:305` | Ephemeral Queue + Worker | authenticated canary request | On demand, unique queue, closes resources | None continuously | Required canary |
| `domains/sites/rateLimit.js:17` | `sites:rate-limit:*` INCR/EXPIRE/TTL | public form submission | Request-driven, 1-3 commands/request | Per request, no idle load | Required |
| `domains/studio/generation/clientOrchestrator.js` | generation cache/lock keys | API requests | Request-driven GET/SET/DEL | No idle load | Required |
| `domains/billing/serviceHealth.service.js` | service-health cache keys | API requests | Request-driven GET/SET/DEL/PING | No idle load | Required |
| `domains/industry/propertyData.service.js` | property cache keys | API requests | Request-driven GET/SET | No idle load | Required |
| OAuth state modules (`google`, `x`, codec) | short-lived OAuth state keys | OAuth requests | Request-driven GET/SET/DEL | No idle load | Required security control |
| `domains/studio/tokenRefreshService.js` | refresh locks | API requests | SET NX and compare-delete | No idle load | Required idempotency |
| `domains/internal/jobs.service.js` | Queue depth/history | authenticated admin request | On demand; multiple commands/queue | No idle load | Required operator surface |
| `squadpitch-ai/core/dependencies.py:49` | Redis readiness client | AI API lifespan | PING cached for 60 seconds; client reused/closed | One AI API machine | Required |
| `squadpitch-ai/worker/heartbeat.py:14` | `sp:worker-health:heartbeat:*`, instances zset | AI worker | SET + ZADD + ZREMRANGEBYSCORE /120 seconds | One machine | Required |

No `QueueScheduler` or `JobScheduler` class is instantiated. BullMQ v5 manages
delayed/repeat scheduling internally. No Redis session store or Redis pub/sub was
found. Web and sites contain no Redis client package or startup path.

## Command-volume diagnosis

The only measured historical figure available to this code audit is the bill:
about $280 at $0.20/100,000 commands, implying roughly 140 million commands per
month, or 54 commands/second averaged over 30 days. Upstash command metrics must
be used to attribute that total precisely.

The following figures are inferred using one empty blocking operation per
`drainDelay` window; BullMQ scripts, retries, reconnects, repeat maintenance and
provider accounting can multiply this. They are ranges, not billing promises.

| Idle contributor | Before | After | Approximate monthly change |
|---|---:|---:|---:|
| BullMQ blocking workers | 34 / 5-second default | 17 / 15 seconds | 17.6M to 2.9M baseline blocking operations |
| BullMQ stalled checks | 34 / 30 seconds | 17 / 60 seconds | 2.94M to 0.73M checks (script command accounting varies) |
| API worker heartbeat | 2 × 3 / 30 seconds | 1 × 3 / 120 seconds | 0.52M to 0.065M |
| AI worker heartbeat | 3 / 30 seconds | 3 / 120 seconds | 0.26M to 0.065M |
| AI readiness | connection + PING /30 seconds | reused client + at most PING /60 seconds | 0.086M to 0.043M plus avoided connection overhead |
| API readiness | PING + all-queue scans when called | cached PING + heartbeat keys only | Frequency-dependent; large per-request reduction |
| Liveness probes | zero Redis commands | zero | none |

The modeled known idle floor falls from roughly 21.4M to 3.8M Redis operations
per 30-day month before multipliers. The gap between 21.4M modeled and 140M
historically billed is unresolved evidence that BullMQ Lua command accounting,
reconnect behavior, previous replica counts, external monitoring frequency, or
another historical deployment contributed materially. See
`redis-cost-verification.md` for measurement and rollback gates.

## Safety and deliberate non-changes

- No queue, delayed job, repeat schedule, or Redis key is deleted.
- Retries, tenant authorization, locking, audit behavior, and job payloads are unchanged.
- No customer-visible schedule cadence was changed.
- QueueEvents remains limited to on-demand verification.
- BullMQ was not replaced and queue names are unchanged.
- Existing bounded producer retention is preserved; a shared bounded policy is
  documented and tested for new queue code. Existing numeric retention limits
  range from 20-100 completed and 100-500 failed jobs.

## 250 MB storage constraint and payload audit

The Upstash database has a 250 MiB production limit. Every one of the 17 named
queues now receives bounded defaults, including queues constructed only by
schedulers or manual-sync helpers. Successful history is bounded to 100 jobs or
24 hours and failed history to 500 jobs or 14 days unless an existing queue has
a stricter bound. The synthetic worker-health job remains until its waiter reads
the result and is then explicitly removed; failed synthetic history is bounded.

The payload review found no image/video bytes or base64 media in BullMQ. Media,
video, persona, metrics, analytics, and poll queues already pass database IDs and
small option objects. The following notification payloads can be materially
larger and should be normalized in a compatibility-preserving follow-up:

| Queue/job | Current payload | Recommended durable reference |
|---|---|---|
| `sp-notification` email/SMS | recipient plus notification payload | `notificationLog.id`; load recipient/template data from Postgres |
| `sp-notification` push | endpoint, public key, auth value, title/body | subscription ID plus notification record ID |
| `sp-notification` webhook/Slack | outbound request payload | webhook delivery ID; request body already exists in Postgres |
| `sp-notification` integration jobs | integration config and event payload | integration ID plus a durable delivery/event ID |
| `sp-media-gen` | asset ID plus bounded generation overrides | Keep; no binary data found |

Those schemas were deliberately not changed in this pass because queued jobs
from the prior release must remain consumable during a rolling deploy. Retention
and cleanup bound their storage now; an additive worker that accepts both legacy
payloads and new IDs should precede producer migration.

Operators can run `npm run diagnose:redis-storage` for `used_memory`, key count,
250 MiB utilization and the 50%/70%/85% status. Run
`node scripts/redis-storage/measure.js --sample-seconds=3600` to measure a
one-hour growth rate without writing to Redis. The output contains no keys,
values, URLs or credentials.

The 2026-08-03 production sample reported 29,197,348 bytes (11.14% of the 250
MiB constraint) and 205,452 keys. A 30-second second sample reported 29,197,423
bytes and 205,453 keys: measured growth of 75 bytes and one key, or a purely
mathematical 9 KB/hour extrapolation. This short window is not a reliable growth
forecast; retain the one-hour, 24-hour, and seven-day observations. One initial
Upstash `INFO` response returned `used_memory:0`; the diagnostic treats such
responses as provider-metric unavailable rather than zero storage. Sampling
every key with `MEMORY USAGE` was rejected because it would itself add more than
205,000 commands and worsen the incident under investigation.

The guarded cleanup dry-run measured the largest retained histories: scheduled
publish 164,535 completed/671 failed; metrics sync 17,588/2,173; GBP 10,311/13;
YouTube 6,845/9; Threads 6,841/9; Facebook 5,921/9; Instagram 5,921/9. This is
direct evidence that legacy recurring jobs retained history beyond current
bounds. No cleanup was executed during the audit.

`npm run cleanup:redis-history` is dry-run by default. Execution requires both
`--execute` and `--confirm=DELETE_EXPIRED_HISTORY`. It calls BullMQ `clean` only
for `completed` older than 24 hours and `failed` older than 14 days, on the exact
17-name allowlist. It never uses key patterns, `FLUSHDB`, `FLUSHALL`, or deletion
of active, waiting, delayed, paused, repeatable, or running jobs.

## Deployment requirement

Deploy the updated `fly.toml`, then explicitly verify Fly created one `worker`
process Machine and retained the intended API Machine count. The API process must
show `PROCESS_ROLE=api`; the worker command overrides it to `worker`. Do not set
`ENABLE_WORKERS=true`; it is deprecated and no longer starts consumers.
