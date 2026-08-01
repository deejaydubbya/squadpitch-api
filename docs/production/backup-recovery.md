# Backup, Restore, and Data Recovery

This runbook is for a non-production recovery exercise and a real incident. It
does not authorize destructive production commands. Provider retention,
point-in-time recovery (PITR), and export settings must be confirmed in their
dashboards; repository configuration alone is not evidence that backups exist.

## Objectives and ownership

The targets below are operating assumptions until a timed restore proves them.
The incident commander owns sequencing, the database owner owns Postgres, the
application owner owns reconciliation, and the security owner controls secret
release and rotation.

| System             | Data role                                                                                                  | Classification                         | Assumed RPO        | Assumed RTO            |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------ | ---------------------- |
| Postgres           | Application system of record, encrypted provider tokens, billing mirror, inbox, audit and idempotency rows | Irreplaceable                          | 15 minutes         | 4 hours                |
| Cloudinary         | Uploaded and generated media bytes                                                                         | Irreplaceable                          | 24 hours           | 8 hours                |
| Redis/BullMQ       | Cache, locks, OAuth nonces, rate state, delayed/retry jobs and repeat schedules                            | Mixed                                  | 1 hour             | 2 hours                |
| Secrets/config     | Encryption keys, provider credentials, signing secrets and deployment configuration                        | Irreplaceable                          | Every change       | 2 hours                |
| Stripe             | Payments, invoices, customers and subscriptions                                                            | External system of record              | Provider-managed   | 4 hours to reconcile   |
| Auth0              | Identities, credentials, roles, Actions, applications and connections                                      | External system of record              | 24 hours           | 8 hours                |
| AI retrieval/index | Current implementation is an in-process derived index                                                      | Rebuildable from authoritative sources | None independently | 8 hours after Postgres |

Missing any RPO is a data-loss window, not a promise. Do not publish these
targets as an SLA until two consecutive quarterly drills meet them.

## Current production evidence (2026-07-31)

The read-only provider audit is recorded in
[`restore-tests/2026-07-31.md`](restore-tests/2026-07-31.md). Production uses a
single-node unmanaged Fly Postgres instance in `ord` on one encrypted 3 GB
volume. Five successful daily volume snapshots were visible with five-day
retention. The 2026-08-01 06:14:58 UTC snapshot was restored into an isolated
target and PostgreSQL became ready in 3 minutes 57 seconds; aggregate-only
validation completed in 8 minutes 5 seconds. WAL/PITR backups remain disabled,
so no earliest PITR point exists. The measured timings prove this snapshot
restore path, not full application recovery or the target RPO/RTO. See the
linked evidence for scope and retained cleanup resources.

## Inventory and recovery properties

### Postgres

Postgres is authoritative for users linked by Auth0 subject, workspaces,
campaigns/drafts, scheduled publishing state, media metadata, encrypted social
tokens, integrations, inbox messages, outbound-send idempotency, Stripe event
ordering markers, audit data, and account-lifecycle requests. It must have
provider-managed backups plus PITR. A logical export is useful for portability
but is not a substitute for PITR.

Required evidence: backup status and retention, earliest recoverable timestamp,
region, encryption, last successful snapshot, a documented restore target, and
a restore performed into an isolated database within the last 90 days.

### Cloudinary

Media bytes are not contained in the database backup. `MediaAsset` records point
to Cloudinary URLs/public identifiers. Loss of Cloudinary assets leaves valid
database rows referencing missing bytes. Confirm asset versioning/backup or
maintain a separate export preserving public IDs, resource type, transformations,
metadata, and original bytes. Test both image and video restoration.

### Redis and BullMQ

Redis is **both cache and durable runtime queue state**:

- Rebuildable: response caches, rate counters, short-lived deduplication locks,
  OAuth state/nonces and health counters.
- Operationally durable: BullMQ delayed jobs, retries, failed-job context and
  repeatable scheduler metadata.

Redis loss must not cause authoritative data loss, but it can drop or duplicate
pending work. OAuth flows in progress must be restarted. Restore Redis only when
its snapshot is known to be consistent; otherwise start empty and reconcile
from Postgres. Pause workers during reconciliation. Recreate repeat jobs
idempotently by starting exactly one worker scheduler, then inspect queue counts.
Requeue database-backed scheduled drafts and pending jobs using stable
idempotency keys. Never bulk replay unknown jobs.

### Scheduled jobs and webhooks

Scheduled publishing is recoverable from Postgres draft status and
`scheduledFor`; BullMQ is the execution mechanism. Pollers and recurring jobs
are code-defined and can be reseeded. Provider webhook payloads are generally
not a backup. Stripe remains replayable from its event history, while local
ordering markers (`lastStripeEventId` and `lastStripeEventCreated`) protect
against duplicates and stale delivery. Inbox outbound sends use database unique
idempotency keys. Preserve those rows before replay.

For each provider, establish its event-retention window before an incident.
Replay oldest to newest, one provider at a time, while workers are controlled.
Record event IDs, time ranges, counts, and reconciliation results.

### Stripe

Stripe is authoritative for money movement and subscription objects; Postgres is
the application entitlement mirror. Do not restore Stripe from Postgres.
Restore Postgres first, keep billing mutations disabled, export affected Stripe
customers/subscriptions/invoices/events, replay or reconcile events in creation
order, and compare plan, status, period, cancellation, and customer IDs. Any
disagreement is resolved from Stripe with an audit entry.

### Auth0

Auth0 is authoritative for login credentials and identity-provider state.
Postgres links records using Auth0 subjects but cannot recreate credentials.
Export and version tenant configuration without secrets, and separately escrow
application credentials, connection secrets, Actions and role mappings. Confirm
the tenant’s supported user-export/import procedure and password-hash
limitations. After recovery, validate issuer, audience, callbacks, logout URLs,
origins, roles, Actions, and a least-privilege login.

### AI retrieval and indexes

The current `squadpitch-ai` retrieval store is in process memory and uses
deterministic derived embeddings. It is not an independently durable production
index. It can be rebuilt only while authoritative source records remain in
Postgres. Before enabling retrieval as a production dependency, implement and
test a workspace-scoped full reindex, checkpointing, deletion/invalidation
replay, and count/hash reconciliation. `SP_AI_POSTGRES_DSN` and
`SP_AI_REDIS_URL` are production configuration dependencies, but no code evidence
shows a durable retrieval index stored in either today.

### Secrets and configuration

Keep an access-controlled inventory of Fly secrets, API/web runtime variables,
database/Redis URLs, Cloudinary, Auth0, Stripe, Postmark, Twilio, social provider,
AI-provider and service-auth values. Never place secret values in this runbook,
Git, tickets, test output, or backup metadata. The token-encryption key must be
restored before encrypted integration tokens are usable. Restore webhook signing
secrets before accepting callbacks. After a suspected compromise, restore
configuration and rotate credentials rather than reusing the backup values.

## Restore order

1. Declare the recovery point and isolate the target environment. Disable
   outbound publishing, email/SMS, billing writes, webhook consumption and all
   workers.
2. Restore/verify the secret escrow and non-secret configuration. Do not expose
   the recovered environment publicly.
3. Restore Postgres to a new non-production instance. Record provider operation
   ID, source timestamp and target connection without logging credentials.
4. Run schema compatibility checks. Use `prisma migrate status`; do not run a
   release migration until the restored schema version is understood.
5. Restore Cloudinary assets into an isolated folder/account or validate a
   read-only recovery copy; preserve public-ID mappings.
6. Restore Redis only if a trustworthy snapshot is required. Prefer an empty
   instance followed by database reconciliation for stale/uncertain snapshots.
7. Start the API with outbound effects blocked and workers disabled. Run health,
   tenant isolation and representative read checks.
8. Start one scheduler instance to recreate repeat definitions. Reconcile and
   selectively requeue pending database-backed work.
9. Rebuild derived analytics and AI retrieval data after authoritative records
   and media are valid.
10. Reconcile Auth0 identities/roles and Stripe subscriptions. Replay retained
    webhooks only with idempotency guards active.
11. Validate, obtain incident-commander approval, then enable inbound traffic,
    workers and outbound effects in controlled stages.

## Non-production restore procedure

1. Open a change record with incident owner, recovery timestamp, target RPO/RTO,
   data classification and explicit confirmation that the target is isolated.
2. Capture safe metadata only: timestamps, object counts, schema/migration
   versions, backup IDs and checksums. Never capture connection strings or
   secrets.
3. Provision new non-production Postgres, Redis and media destinations. Deny
   production provider callbacks and use test-mode provider credentials.
4. Restore the selected Postgres recovery point. Verify database connectivity
   read-only, migration history, table counts, foreign-key health and a sample
   of each high-value entity.
5. Restore a representative media set and verify its checksum/content type,
   ownership, original rendition and one transformed rendition.
6. Start with `ENABLE_WORKERS=false` and all outbound/poller feature flags off.
   Verify authentication using a non-production Auth0 tenant/user.
7. Compare scheduled drafts, pending lifecycle requests, inbox sends,
   subscriptions and webhook ordering markers against pre-restore metadata.
8. Attach an empty recovery Redis. Start a single worker instance, verify repeat
   schedules, then requeue a small allowlisted sample. Confirm idempotent rerun.
9. Rebuild derived data. Confirm retrieval cannot cross workspaces and that
   deleted/invalidated sources do not return.
10. Execute the checklist below, record elapsed time and data-loss boundary,
    destroy the isolated recovery environment under a separately approved
    cleanup change, and retain the evidence.

## Post-restore validation checklist

- [ ] Recovery timestamp and measured RPO/RTO recorded.
- [ ] Restored target is isolated and has no production callbacks.
- [ ] Migration history matches the restored application release.
- [ ] Core table counts and sampled workspace relationships reconcile.
- [ ] Tenant A cannot read or mutate Tenant B.
- [ ] Encrypted provider tokens decrypt only with the restored key; logs expose none.
- [ ] Image and video originals plus transformations load.
- [ ] Scheduled drafts are neither missing nor published twice.
- [ ] Repeat schedulers exist exactly once.
- [ ] Failed/delayed jobs were explicitly reconciled, not blindly replayed.
- [ ] OAuth flows started before Redis loss are rejected and restarted.
- [ ] Stripe subscription/entitlement samples match Stripe.
- [ ] Duplicate and out-of-order Stripe events do not regress state.
- [ ] Auth0 login, role enforcement and account disable/delete behavior pass.
- [ ] Email/SMS/social actions remain in test mode until final approval.
- [ ] Inbox send idempotency prevents a duplicate provider action.
- [ ] Webhook signature rejection and replay behavior pass.
- [ ] AI retrieval is rebuilt from approved sources, tenant-scoped and deletion-aware.
- [ ] Health/readiness, production-config validation and smoke tests pass.
- [ ] Observability, alerts and audit events are visible.
- [ ] Evidence includes backup IDs, counts/checksums, timings, deviations and owner sign-off.

## Manual provider actions

These are dashboard actions and must be completed by authorized operators:

- Postgres provider: enable and document PITR/retention, access controls,
  encryption, region and restore-to-new-instance procedure.
- Cloudinary: confirm backup/versioning coverage and export/restore semantics for
  originals, videos, metadata and public IDs.
- Redis provider: confirm AOF/RDB policy, snapshot frequency, retention and
  restore-to-new-instance capability; document whether eviction can affect
  BullMQ keys.
- Fly: maintain a secret-name/config inventory, escrow values outside Fly, and
  test restoration into a non-production app.
- Stripe: confirm event retention/replay access and grant least-privilege
  Workbench access to recovery operators.
- Auth0: export tenant configuration and document supported user export/import,
  connection-secret escrow and role/Action restoration.
- Postmark, Twilio and each social provider: document event/log retention,
  credential rotation and webhook reconfiguration procedures.

## Safe metadata validation

Run `npm run verify:backup-recovery` for human-readable status or
`npm run verify:backup-recovery:json` for machine-readable output. It reports
runbook, provider-backup, recent-backup, PITR, restore-test and restore-validation
evidence separately. It reads recorded evidence and does not connect to or
mutate Postgres, Redis, Cloudinary, Fly, Stripe, Auth0, or any provider. A
runbook or snapshot alone never produces full recovery readiness.
