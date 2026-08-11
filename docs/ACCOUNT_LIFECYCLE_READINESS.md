# Account and workspace lifecycle readiness

> **Policy update:** Retention Policy v1 is approved and implemented. The
> canonical data map, seven-day export/grace rules, automated purge, provider
> retries and DR tombstone procedure are in
> [production/RETENTION_POLICY_V1.md](production/RETENTION_POLICY_V1.md).

## Identity and ownership map

- Auth0 is the identity provider. Login, logout, password reset, email
  verification, session expiry, and credential policy remain Auth0-managed.
- `User.auth0Sub` maps the Auth0 identity to the application user.
- `Client.createdBy` stores that Auth0 subject and is the authoritative
  workspace-owner relationship. There is currently no multi-member workspace
  membership table despite the global `UserRole` enum.
- `Subscription.userId`, usage, notification preferences, and generic
  integrations use the application `User.id`.
- Workspace children use `clientId`/`workspaceId` and tenant checks must resolve
  back to `Client.createdBy`.

## Implemented lifecycle behavior

### Signup and authentication

Signup-plan intent survives the Auth0 redirect and billing activation remains
webhook-authoritative. Auth0 Universal Login owns verification, password reset,
logout, and session renewal. Dashboard configuration and acceptance testing are
documented in `squadpitch-web/docs/AUTH0_BRANDED_LOGIN_SIGNUP.md`.

### Workspace archive

`DELETE /api/v1/workspaces/:id` is an archive operation, not irreversible data
erasure. It requires this exact JSON confirmation:

```json
{ "confirmation": "ARCHIVE WORKSPACE" }
```

Only the owner may perform it. The transaction:

1. marks scheduled drafts failed so they cannot publish later;
2. archives the public site;
3. deletes channel connections and encrypted OAuth credentials;
4. deletes workspace tech-stack connection metadata;
5. marks the workspace `ARCHIVED`.

The operation is audited. Archived workspaces return `410 WORKSPACE_ARCHIVED`
from owner-guarded routes, are excluded from normal lists, and are excluded by
the scheduled publishing worker.

### Disconnect and reconnect

Channel disconnect deletes the connection/token row, disables its channel, and
is audited. Reconnect runs a new OAuth authorization and replaces credentials.
Expired/error connections are not published; the worker skips them and the UI
directs the owner to reconnect.

### Account deletion and export requests

These authenticated endpoints create durable, idempotent lifecycle requests:

```text
POST /api/v1/account/deletion-request
POST /api/v1/account/export-request
```

Deletion requires `{ "confirmation": "DELETE MY ACCOUNT" }`. It immediately
archives all workspaces owned by the caller, disables scheduled publishing and
sites, and removes stored workspace connections. It does **not** claim that
legal deletion is complete. The response explicitly says manual completion is
required.

Operations must then verify ownership and complete the provider/data-system
checklist:

1. review the request and retained-record obligations;
2. cancel or otherwise resolve the Stripe subscription and preserve required
   billing/tax/dispute records;
3. remove Auth0 identity only after verification and service shutdown;
4. delete Cloudinary and other provider assets identified from owned records;
5. remove or anonymize application records, logs, exports, and caches according
   to the approved retention schedule;
6. handle queued BullMQ jobs and verify no worker can act for an archived
   workspace;
7. document backup expiry rather than attempting selective backup mutation;
8. mark the lifecycle request completed with operator notes and notify the
requester. Retention Policy v1 replaces this former manual-only completion
step with a daily idempotent purge and provider-retry worker. The operator
checklist remains useful for persistent external failures.

## Public-policy comparison

The public Data Deletion page correctly describes a verified email/manual
workflow, a 30-day target, provider revocation, legal retention exceptions, and
backup rollover. The previous workspace DELETE implementation only archived
data and therefore could not by itself satisfy language saying production data
“will be removed.” The new lifecycle request records and immediate shutdown
make the first stage truthful, but the final purge still requires an operator
runbook and approved retention rules.

The phrase “delete your workspace” must not be used for the archive endpoint.
UI copy should say **Archive workspace and disconnect integrations**. “Deletion
completed” may be communicated only after the durable request is marked
`COMPLETED`.

## Superseded policy questions

The retention durations, export format/expiry, grace period, contact purge,
Cloudinary target, Auth0 ordering and backup treatment below were unresolved
when this readiness document was first written. They are now resolved by
Retention Policy v1. Multi-user ownership remains out of scope because there
is no membership model.

1. Required retention periods for billing, tax, security, abuse, disputes,
   audit logs, AI traces, and backups.
2. Whether workspace archival is reversible, and if so who may restore it.
3. Whether deletion automatically cancels Stripe immediately or waits for an
   operator, and how refunds/end-of-period access are handled.
4. Whether account exports are generated automatically or manually, their
   format, secure delivery method, expiry, and included provider data.
5. How cloud media, generated-model artifacts, deployed Sites, and third-party
   copies are enumerated and erased.
6. Whether customer contacts are controller data and how workspace owners'
   deletion instructions interact with contact privacy requests.
7. Multi-user workspace ownership, transfer, last-owner protection, member
   removal, and administrator semantics. These are not implemented today.
8. Auth0 account linking, verified-email requirements, and what happens when an
   Auth0 identity is deleted before application cleanup finishes.
9. Legal review of the stated seven-business-day acknowledgement and 30-day
   completion targets.
