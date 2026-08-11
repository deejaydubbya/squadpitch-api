# Production recovery index

Use this order for an isolated recovery. Never restore over production and
never point production callbacks, OAuth redirects, webhooks, email, publishing,
or billing at the isolated environment.

1. **Postgres:** follow [backup-recovery.md](backup-recovery.md). Restore the
   selected `squadpitch-postgres` snapshot to an isolated target, validate
   Prisma migration history and aggregate tenant counts, and record RPO/RTO.
2. **API:** provision an isolated API with outbound/customer actions disabled,
   point only its database connection at the restored target, and verify
   `/health` then `/ready`.
3. **Redis:** start empty. Redis contains cache, locks, rate-limit state,
   BullMQ jobs, and worker heartbeats—not authoritative customer records. Do
   not copy delayed jobs into recovery without an explicit idempotency review.
4. **Cloudinary:** database rows retain asset references. Verify a bounded
   sample of referenced resources through read-only delivery URLs and the
   provider backup state; do not bulk-delete or overwrite assets.
5. **Auth0:** use the dedicated read-only recovery credential to reconcile
   identities with restored `User.auth0Sub` ownership. Do not delete or modify
   tenant identities during a drill.
6. **Stripe:** run `npm run verify:stripe-reconciliation` with the dedicated
   `rk_live_` recovery key. Stripe remains authoritative; never use the normal
   unrestricted billing key for reconciliation.
7. **Postmark:** restore configuration names from the secret inventory and run
   configuration validation. Do not send the production canary from an
   isolated drill unless its allowlisted recipient and operator approval are
   explicitly in scope.
8. **AI/retrieval:** no durable vector index currently exists. Retrieval rows
   are rebuilt in memory on each authenticated query from authoritative
   snapshot items supplied by Postgres. Validate the retrieval contract and
   benchmark; there is no destructive reindex step.
9. **Canary:** run health/readiness, then the authenticated synthetic canary
   against the isolated hostname and synthetic workspace. Keep publishing,
   media generation, email, SMS, and billing writes disabled.
10. **Teardown:** capture sanitized timings and evidence, revoke temporary
    access, destroy temporary compute/database resources, and confirm no
    production DNS, secret, or webhook configuration changed.

The measured snapshot restore-to-ready baseline is 3 minutes 57 seconds; see
[restore-tests/2026-07-31.md](restore-tests/2026-07-31.md). A full application
drill remains a separate temporary-resource exercise because creating an
additional database/API environment can incur provider cost.
