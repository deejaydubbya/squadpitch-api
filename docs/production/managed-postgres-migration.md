# Managed Postgres and PITR migration plan

## Decision and exit criteria

Recommendation: migrate the current single-node unmanaged Fly Postgres 17
database to **Fly Managed Postgres (MPG)** in `ord`. It is the simplest fit:
the API remains on Fly, private networking avoids a cross-cloud database path,
and Fly manages backups, PITR, pooling, monitoring, patching, and failover. Neon
is the fallback if MPG pricing, retention, support, or testing does not meet the
requirements below.

Do not perform the migration as part of documentation work. Public acquisition
stays blocked until the chosen service is provisioned, PITR retention is
confirmed, migration and rollback rehearsals pass, and an isolated PITR restore
is validated.

## Current architecture

- PostgreSQL 17.2 runs on one unsupported/unmanaged Fly Machine in `ord`.
- One encrypted 3 GB volume is authoritative.
- Daily volume snapshots with five-day retention and one successful snapshot
  restore are proven.
- WAL/PITR and HA failover are absent.
- API deployments consume `DATABASE_URL`; Prisma owns schema migrations.

## Option A — Fly Managed Postgres

### Architecture and capabilities

Provision an MPG cluster in `ord` with a provider-managed primary/replica
topology, connection pooling, automated backups, documented PITR retention,
failover, SSL/private networking, and monitoring. Confirm the exact plan,
storage, retention, support, encryption, and backup location in the Fly
dashboard before purchase; current cost is plan plus storage.

### Migration and downtime

For the current small database, rehearse a PostgreSQL 17 custom-format
`pg_dump`/`pg_restore` into a non-production MPG cluster. Then:

1. Create least-privilege runtime and migration roles. Record pooled and direct
   endpoints through the approved secret system.
2. Restore a rehearsal dump and measure export, import, and validation time.
3. Schedule a write-maintenance window. Pause workers, publishing, webhooks,
   lifecycle jobs, and API writes.
4. Take a final dump from the direct source connection and restore to MPG.
5. Validate migration history, aggregate counts, foreign keys, workspace
   ownership, tenant isolation, settings, timezone, and extensions.
6. Atomically replace `DATABASE_URL` for API and every direct consumer. Use the
   pooled endpoint for runtime traffic and the provider-recommended direct
   endpoint for Prisma/release operations if PgBouncer transaction mode requires
   it. Apply MPG's SSL requirements.
7. Deploy with side effects disabled, run canaries, then enable traffic and
   workers in stages.

Expected write downtime is the measured final dump/restore, validation, and
secret rollout—likely minutes at current size, but rehearsal timing is the only
approved estimate. Prisma remains compatible with standard PostgreSQL. Run
`prisma validate`, `prisma migrate status`, and confirm zero pending/failed
migrations; never reapply the 67 recorded migrations.

### Rollback

Keep the old database running but write-frozen and isolated for the observation
window. Before target writes, revert `DATABASE_URL` and restart consumers. After
target writes, never switch back blindly: stop writes and reconcile the delta or
restore an approved export before owner-approved rollback. Destroy neither
database until rollback is closed and evidence retained.

### Cost, backups, HA, and monitoring

- Quote the smallest production HA plan plus storage, backups, and support.
- Record frequency, retention, earliest PITR point, restore-to-new-cluster
  behavior, encryption, and region from live evidence.
- Alert on availability, connection/pool saturation, CPU, memory, storage,
  failover/replication, latency, and backup/PITR failures.
- Complete a timed PITR-to-isolated-cluster drill before setting
  `PITR_CONFIRMED: PASS`.

## Option B — Neon managed Postgres

### Architecture and capabilities

Create a paid Neon project in a North American region with multi-AZ durable
storage, a production compute endpoint, built-in PgBouncer pooled endpoint,
direct administrative endpoint, monitoring, and a configured restore window.
Neon Launch currently advertises usage pricing, seven-day time-travel/restores,
pooling, and multi-AZ storage; confirm current limits and support at selection.

### Migration and downtime

Use Neon's Import Data Assistant or separate custom-format `pg_dump` and
`pg_restore` files over unpooled endpoints. Rehearse first, then use the same
controlled write pause and final dump/restore sequence as Option A. If measured
downtime becomes unacceptable, test logical replication, keys, extensions,
sequences, lag-to-zero, and a brief final write pause before cutover.

Set runtime `DATABASE_URL` to the pooled SSL-required endpoint and use a separate
direct URL for Prisma administrative work where required. Fly-to-Neon traffic
crosses provider networking, so load-test latency and include egress. Validate
pooling mode, prepared statements, connection limits, extensions, SSL, and
standard Prisma/PostgreSQL compatibility.

### Rollback

Before target writes, revert the secret. After target writes, stop traffic and
reconcile changes; do not dual-write or reverse-replicate without a tested
conflict and sequence plan. Retain the frozen Fly source and final export through
the observation window.

### Cost, backups, HA, and monitoring

- Compare compute-unit, database/history storage, egress, support, and restore
  window charges against MPG and set budget alerts.
- Configure a paid restore window; do not rely on a free-tier window for
  production.
- Verify multi-AZ behavior, compute availability, pooling, metrics, logs, backup
  history, and restore into a separate branch/target.
- Alert on availability, saturation, latency, storage/history consumption,
  migration lag, and restore-window coverage.

## Required completion checklist

- [ ] Select provider/plan, owner, budget, region, retention, and maintenance window.
- [ ] Inventory extensions, roles, grants, settings, and connection consumers.
- [ ] Provision an isolated target with no outbound application side effects.
- [ ] Rehearse export/import; record dump, restore, validation, and cutover time.
- [ ] Validate all 67 migrations, aggregates, foreign keys, and tenant isolation.
- [ ] Exercise pooled runtime and direct Prisma paths with required SSL.
- [ ] Approve pre-write and post-write rollback procedures.
- [ ] Cut over under a write pause with workers/webhooks/publishing controlled.
- [ ] Monitor and reconcile Stripe/Auth0/provider state; retain the frozen source.
- [ ] Perform an isolated PITR restore and record proven RPO/RTO.
- [ ] Set `PUBLIC_ACQUISITION: ALLOWED` only after the verifier passes, then
      retire the old database under separate approval.

## References

- [Fly Managed Postgres CLI and restore operations](https://fly.io/docs/flyctl/mpg/)
- [Fly managed Postgres capabilities](https://fly.io/learn/what-is-the-best-postgres-hosting/)
- [Neon migration tooling](https://neon.com/migration)
- [Neon plans, pooling, HA, and restore windows](https://neon.com/pricing)
