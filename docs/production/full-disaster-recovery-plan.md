# Full Disaster Recovery Plan

**Status: EXTERNAL VERIFICATION REQUIRED.** This plan does not enable backups,
restore production, or establish an achieved RPO/RTO. Current evidence proves
only daily snapshots and one isolated aggregate-only database restore.

## Proposed objectives and state classification

| State | Class | Proposed RPO/RTO | Recovery source |
|---|---|---|---|
| Postgres + Prisma history | Authoritative | 15 min / 4 h | Provider PITR plus immutable release/migration history |
| Cloudinary media | Authoritative bytes | 24 h / 8 h | Provider versioning/export and checksum inventory |
| Redis/BullMQ | Mixed ephemeral/runtime-durable | 1 h / 2 h | Approved persistence or empty restore plus DB reconciliation |
| Fly/GitHub config | Reproducible configuration | every change / 2 h | Git commit, Fly app config, deployment SHA |
| Encryption/signing/provider secrets | Irreplaceable key material | every change / 2 h | approved encrypted escrow |
| Stripe/Auth0/provider records | Externally authoritative | provider managed / 4–8 h | provider export/API reconciliation; never overwrite from DB |
| AI indexes/caches | Rebuildable derived | none / 8 h after DB | authoritative Postgres sources and versioned rebuild tooling |
| DNS/Cloudflare/callbacks/alerts | External configuration | every change / 4 h | provider exports and operator inventory |

Legal/operations must approve the proposed objectives before they become
commitments.

## Quarterly isolated exercise

1. Open a change record with incident commander, DB, application, security,
   media, identity/billing, and communications owners and escalation contacts.
2. Record recovery timestamp, desired release SHA, proposed RPO/RTO, snapshot or
   PITR point, and evidence directory. Never place secrets in evidence.
3. Provision a new environment whose hostname, Fly app names, database name,
   and `NODE_ENV` are unmistakably non-production. Restore tooling must refuse
   production app names/URLs/database hosts.
4. Set all email, SMS, publishing, webhooks, billing mutation, callbacks,
   scheduled jobs, and external provider side effects disabled before startup.
5. Restore Postgres to the isolated target. Verify Prisma migration rows against
   the selected release before running `prisma migrate deploy`; never use
   `db push` for recovery.
6. Restore or reconcile a representative Cloudinary inventory and compare
   counts, public IDs, byte sizes, content types, and checksums.
7. Start with empty Redis unless a consistent provider snapshot and policy were
   approved. Recreate repeat schedules, reconcile scheduled drafts and webhook
   idempotency markers from Postgres, and prove no duplicate job executes.
8. Restore encryption and signing keys from escrow only into the isolated
   secret store. Validate presence/fingerprints without printing values. Prove
   encrypted OAuth tokens decrypt; do not call providers.
9. Deploy API, web, sites, AI, and worker at the matching SHA. Rebuild derived AI
   indexes from Postgres and record duration/counts.
10. Reconcile Stripe/Auth0/provider identifiers read-only. Keep callback URLs
    and webhook delivery pointed away from the recovery target.
11. Run the production-readiness validator in isolated mode and the supported
    authenticated synthetic canary with publishing, billing, email, and SMS
    suppressed. Compare tenant-scoped counts and safe aggregate checksums.
12. Record actual recovery point, data gap, service-ready time, full-canary time,
    failures, exceptions, and operator signatures in a new evidence file.
13. Revoke temporary credentials and destroy Fly machines, volumes, databases,
    Redis, media copies, DNS entries, and CI grants through approved provider
    procedures. Record resource IDs and destruction confirmation, never secret
    values.

## Go/no-go evidence

The existing `scripts/backup-recovery` inventory/validator is the durable gate.
Full readiness requires PITR, recent backup, isolated restore, full validation,
media recovery, queue reconciliation, key recovery, AI rebuild, and authenticated
canary evidence. A runbook, environment variable, or successful aggregate count
alone is not sufficient. Until a real exercise meets approved RPO/RTO,
`publicAcquisitionReady` must remain false and the controlled-beta warning must
remain visible.

No backup provider, Fly, database, Redis, media, DNS, or secret setting was
changed while creating this plan.
