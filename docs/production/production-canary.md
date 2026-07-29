# Production Canary / Synthetic Customer

The production canary uses a dedicated Auth0 identity and workspace through the
normal customer authorization path. It has no admin/developer role, bypass,
service credential or cross-workspace permission. The API allowlists exactly one
workspace ID and requires its name to begin with `[SYNTHETIC CANARY]`.

## What the canary verifies

- Auth0/API authentication and normal workspace ownership middleware
- Workspace lookup and active status
- Postgres write/read inside a transaction that is deliberately rolled back
- Billing entitlement/usage lookup without checkout or charge
- Hosted `squadpitch-ai` dry-run operations and provenance
- Explicit fallback status
- A dedicated BullMQ queue job that is enqueued, consumed and removed
- SquadSites runtime health
- Presence—not validity or approval—of integration provider configuration
- Publishing boundary: no adapter invocation
- Media boundary: skipped by default to avoid paid generation

The output contains only synthetic run/workspace identifiers, status, timing and
safe messages. It never returns credentials, provider tokens, user email, card
data, content or webhook bodies.

## Manual account setup

1. In the production Auth0 tenant, create a dedicated synthetic user using a
   monitored company-controlled address. Require normal MFA/password policy.
2. Assign no admin, developer or support role and do not grant
   machine-to-machine credentials.
3. Sign in normally and create one workspace named
   `[SYNTHETIC CANARY] Production Monitor`. Use obviously fictional business
   data; never copy customer data.
4. Record its exact workspace ID as the API secret
   `PRODUCTION_CANARY_WORKSPACE_ID`. Set
   `PRODUCTION_CANARY_SITES_HEALTH_URL` to the production runtime health URL.
5. Leave `PRODUCTION_CANARY_MEDIA_ENABLED=false`. Media generation is not part
   of the automatic canary until a bounded provider implementation, cost cap and
   cleanup proof exist.
6. Obtain a short-lived normal user access token or authenticated web session
   immediately before a run. Store it only in the operator shell/approved
   secret mechanism—never source, CI logs, tickets or screenshots.
7. If publishing is later tested, create a private provider destination owned
   solely by the synthetic identity. Configure it separately and require an
   operator action. This canary endpoint never publishes.

## Commands

Direct API with a normal Auth0 access token:

```text
SQUADPITCH_CANARY_BASE_URL=https://squadpitch-api.fly.dev
SQUADPITCH_CANARY_WORKSPACE_ID=<synthetic-workspace-id>
SQUADPITCH_CANARY_TOKEN=<short-lived-normal-user-token>
npm run canary:production
```

Through the authenticated web proxy:

```text
SQUADPITCH_CANARY_BASE_URL=https://app.squadpitch.com
SQUADPITCH_CANARY_WORKSPACE_ID=<synthetic-workspace-id>
SQUADPITCH_CANARY_COOKIE=<short-lived-session-cookie>
npm run canary:production:json
```

`SQUADPITCH_CANARY_RUN_ID` is optional; the runner creates a UUID. Supplying the
same safe run ID makes the queue job idempotent. Never paste the token/cookie
into command history on shared systems.

## Safety and cleanup

- The DB probe creates a clearly marked `WorkspaceDataSource` only inside a
  transaction and forces rollback after reading it.
- The queue probe uses `sp-production-canary`, stable job IDs, and
  `removeOnComplete`/`removeOnFail`; producer, worker and Redis connections are
  closed in `finally`.
- Hosted AI verification is dry-run and does not create drafts, publish, or
  invoke integrations.
- Billing is read-only. No checkout session, subscription update, invoice,
  payment method or card charge is created.
- Provider inspection reads process configuration names only. It does not
  perform OAuth or call providers.
- Repeated execution must not accumulate database fixtures or completed queue
  jobs. A failed run may leave only provider logs and normal observability
  events; inspect the dedicated queue before retrying after a timeout.
- Deleting the synthetic account/workspace remains a separately approved
  lifecycle operation. Never let the canary clean up its own identity.

## Result interpretation

- `PASS`: the check completed with the required safe behavior.
- `WARN`: an optional surface was intentionally skipped or fallback/config
  evidence needs review.
- `FAIL`: an expected production dependency or invariant failed. The command
  exits non-zero.

Retain JSON output with release SHA, operator, start/end time and dashboard
links. Do not claim provider approval or end-to-end publishing from a
configuration-presence PASS.
