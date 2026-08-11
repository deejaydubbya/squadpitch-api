# Squadpitch Retention Policy v1

Founder-approved product and operations policy, effective 2026-08-11. These
durations are operational policy and are not represented as legal mandates.

## Canonical data map

| Resource | Owner | Export | Deletion / retention | Provider and backup behavior |
|---|---|---:|---|---|
| User profile | User/Auth0 subject | Yes | PII anonymized at final purge | Auth0 identity deleted last; encrypted backups expire normally |
| Workspaces/memberships | `Client.createdBy` (no membership model yet) | Yes | Exact-owner workspace graph purged after grace | Current tombstones must be reapplied after DR restore |
| Campaigns, drafts/posts, generated metadata | Workspace | Yes | Cascade-purged | Existing provider posts are not automatically mutated |
| Contacts, leads, form submissions | Workspace | Yes | Cascade-purged | May remain in encrypted backups until normal expiry |
| Property/inventory/business data | Workspace data source/item | Yes | Cascade-purged | External source copies are provider-controlled |
| Inbox conversations/messages | Workspace | Yes | Cascade-purged | Provider-side mail/social history is not mutated |
| Channel and tech-stack connections | Workspace | Metadata only | Stored credentials removed immediately | Tokens/secrets never exported; cancellation requires reconnect |
| Generic integrations/webhooks/Slack | User | Metadata only | Credentials/config removed immediately | External revocation occurs only through supported adapters |
| Media assets | Workspace | Metadata/URLs | DB rows purged; exact encrypted Cloudinary targets retried daily | No folder-wide deletion; 30-day completion target |
| Subscription/billing mirror | User ID | Tier/status summary | Retained seven years; Stripe is authoritative | No card/payment-method data exported or mutated |
| Audit/security logs | Auth0 subject/resource | Sanitized user-relevant entries | Retained one year, then deleted | Same cutoff applies after restore |
| AI traces/debug data | Workspace/actor | Usage summary; raw trace internals excluded | `retentionUntil`, normally 30 days, then deleted | No durable vector index exists |
| Queue/job state | Operational | No | Workspace archive makes jobs inert; bounded history expires | Redis starts empty/reconstructed in DR |
| Analytics/activity | User/workspace | Yes where user-facing | Purged with user/workspace | Irreversibly anonymous aggregates may remain |
| Public Sites | Workspace | Yes | Archived immediately and cascade-purged | Runtime caches expire or are revalidated normally |
| Export request/archive | User | Request metadata | On-demand ZIP; request expires after seven days; no ZIP stored server-side | Authenticated owner check and unguessable request ID |
| Deletion request/tombstone | User, then anonymized hashes | No | Retained seven years | Must be checked before a restore is promoted |

## Export contract

`POST /api/v1/account/export-request` creates an owner-bound request.
`GET /api/v1/account/exports/:requestId/download` generates a ZIP with
versioned JSON sections and `manifest.json` containing byte counts and SHA-256
checksums. Cross-user IDs return 404. Seven days after request creation,
downloads return 410 and daily maintenance closes the request. Passwords,
tokens, secrets, provider configuration and payment details are excluded.

## Deletion state machine

`GRACE_PERIOD -> PARTIAL_PROVIDER_FAILURE -> COMPLETED`, with `CANCELLED` as an
authenticated transition before the seven-day deadline. Confirmation archives
workspaces/sites, fails scheduled drafts and removes stored credentials.
Cancellation restores only prior local workspace status; providers must be
reconnected.

After seven days, maintenance rechecks the request and exact owner, creates
encrypted per-asset Cloudinary tasks and an encrypted Auth0 task, purges the
workspace graph and user product records, anonymizes the User, and retains the
minimized subscription mirror. Provider failures store only sanitized codes,
retry daily and never reactivate the account. Auth0 deletion runs only after
application cleanup. Its dedicated Management API client must have only
`delete:users`, configured as `AUTH0_DELETION_CLIENT_ID` and
`AUTH0_DELETION_CLIENT_SECRET`. `AUTH0_MANAGEMENT_DOMAIN` must be the Auth0
tenant domain (for example, `tenant.us.auth0.com`), not the custom login
domain, because the Management API audience is tenant-specific.

## Recovery and operator procedure

Historical encrypted backups are not surgically edited. Before a restored
environment becomes active, query lifecycle requests with a current
`tombstoneUntil`; any restored active copy of those accounts must be purged
again. Never promote a restore that knowingly reactivates a deleted account.

The worker runs maintenance daily at 03:41 UTC. Operators can safely retry with
`npm run retention:run`. Operations are idempotent. Persistent provider tasks
remain `RETRY` with a sanitized code for operator attention.
