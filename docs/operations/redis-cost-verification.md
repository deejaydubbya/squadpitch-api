# Redis cost verification and rollback

This plan validates command reduction with Upstash metrics without changing
Upstash settings or exposing credentials.

## Baseline

Before deployment, record screenshots/exports for command count, commands per
second, bandwidth, connection count, errors, and latency over both one hour and
24 hours. Record the exact UTC deployment timestamp and Fly Machine counts by
process group. The historical billing-derived baseline is approximately 140
million commands/month (54/second), but current Upstash metrics are authoritative.
Run `node scripts/redis-storage/measure.js --sample-seconds=3600` to capture current
bytes, keys and one-hour growth. Escalate at 50% (125 MiB), 70% (175 MiB), and
85% (212.5 MiB). At 85%, stop nonessential enqueueing only through existing
feature flags and run the guarded expired-history cleanup after reviewing its
dry-run output; do not mutate waiting or scheduled work.

## Expected observations

- At 15 minutes: one API worker process, no worker initialization events from
  API machines, one initialization event per queue from the worker, no reconnect storm.
- At one hour: idle command rate should be materially below the pre-deploy hour;
  saw-tooth heartbeat traffic occurs every 120 seconds.
- At 24 hours: repeat jobs still execute once at their documented cadence,
  retries and scheduled publishing work, and command volume extrapolates well
  below the baseline. Compare like-for-like traffic periods.
- At seven days: no growing command trend, duplicate schedules, backlog, stalled
  job increase, or lost canary execution.

Run `npm run diagnose:redis-topology` in each API process context. It prints only
expected topology and safe runtime identity; it does not connect to Redis or run jobs.

## Metrics attribution

Correlate Upstash changes with structured logs:

- `redis.topology.expected`
- `redis.client.initialized`
- `bullmq.worker.initialized`
- `bullmq.duplicate_initialization_blocked`

Group logs by Fly Machine ID and `processRole`. There must be no
`bullmq.worker.initialized` event from an `api` role. Do not log or export Redis
URLs, job payloads, tenant identifiers, or credentials.

## Acceptance and rollback conditions

Accept when CI passes, API/worker health is green, a worker-health round trip
succeeds, scheduled publishing succeeds, no backlog/stalled regression appears,
and the 24-hour command rate is materially lower than the matched baseline.

Rollback immediately if no worker Machine exists, jobs remain waiting beyond the
existing warning threshold, scheduled publishing misses its window, retries stop,
worker heartbeat is stale, Redis reconnect errors surge, or command rate rises.

Rollback the application release through Fly to the previous image. Because no
Redis data or queue schema is migrated, rollback requires no Redis mutation.
Temporarily restore the prior process topology only as an emergency reliability
measure, then investigate. Never flush Redis or remove repeat/delayed jobs.

## Remaining uncertainty

Source inspection cannot explain the exact historical 140-million-command total.
Upstash command-type and time-series metrics are required to distinguish blocking
operations, Lua scripts, connection churn, and workload commands. Do not state an
exact dollar saving until the seven-day measurement is complete.
