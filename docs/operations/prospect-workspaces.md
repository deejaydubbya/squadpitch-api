# Prospect workspaces operator runbook

Prospect workspaces are restricted, pre-built acquisition previews. They are not customer workspaces until a verified invited user completes a secure claim.

## Create and prepare

1. Sign in with the Auth0 `admin` role and open **Admin → Prospect Workspaces**.
2. Enter the prospect, business, industry, website, and optional listing/source information.
3. Save all links shown after creation. Preview and claim credentials use 256 bits of entropy; only SHA-256 digests are stored, so raw links cannot be recovered.
4. Use `POST /api/v1/internal/prospects/:id/populate` for controlled listing and sample-draft data. It performs database-only writes and never invokes a publisher, provider, scraper, or AI service.
5. Open the prospect's preview editor. Explicitly select and order every listing and draft intended for public display, then save. The dedicated `ProspectPreviewItem` relation is used instead of flags or JSON so tenant references, deletion, uniqueness, and order are database-enforced. An empty selection publishes no workspace records.
6. Open the issued preview on phone and desktop. Confirm public facts and image rights, and verify no private information appears.

## Invite and claim

The secure invitation puts the claim credential in the URL fragment, which browsers do not send to preview servers or request logs. The browser retains claim intent in session storage during normal Auth0 login/signup and sends the credential to the API only in a JSON body.

The API revalidates token digest, expiry, lifecycle, state, verified authenticated email, and invited email. A serializable transaction consumes the token and transfers the existing `Client` to the Auth0 subject. Prepared content is not copied or recreated. Normal subscription/entitlement rules then apply, and the user lands directly in the workspace rather than new-workspace onboarding.

## Rotation, revocation, and expiry

- Regenerate creates a new preview/claim pair and invalidates both old links. Copy it immediately.
- Revoke disables the outstanding claim.
- Default expiry is 21 days; creation accepts 1–90 days.
- Stale records remain admin-visible for retention review; this release does not hard-delete them automatically.
- Preview credentials can be rotated or revoked through the internal API.
- Token rotation preserves preview selection. Deleted or newly ineligible selected records are omitted; no replacement is inferred.

## Security and troubleshooting

- Unclaimed clients use lifecycle `PROSPECT`, status `DRAFT`, and a non-user sentinel owner. Normal workspace APIs reject them. `lib/workspaceLifecyclePolicy.js` also rejects provider-capable publishing, scheduling, OAuth, Inbox email, and Inbox SMS service boundaries. Scheduled publishing and bulk autopilot additionally require lifecycle `CUSTOMER`.
- Public preview output is an explicit allowlist excluding prospect email, operator notes, ownership, provider credentials, analytics, and internal source data.
- Email mismatch means the claimant must use the verified invited email or ask an admin to issue a corrected invitation. Identity is never accepted from query/body parameters.
- Lost links must be rotated; raw credentials cannot be recovered.
- `PROSPECT_WORKSPACES_ENABLED=false` stops creation. `PROSPECT_WORKSPACE_CLAIMS_ENABLED=false` stops claim mutations. Claimed customer workspaces continue normally.

## Deployment

Apply migrations `20260812000000_add_prospect_workspaces` and `20260813000000_add_explicit_prospect_preview_selection` before API deployment. No new infrastructure, DNS, Postmark, Auth0, or provider configuration is required. The current app hostname serves `/preview/:token` and `/claim`.

## Staging release rehearsal

Use only an isolated non-production database, Auth0 tenant, synthetic users, and disabled provider credentials.

```powershell
$env:DATABASE_URL='<staging-postgresql-url>'
node node_modules/prisma/build/index.js migrate deploy
node node_modules/prisma/build/index.js validate
node node_modules/prisma/build/index.js generate
npm test
```

Verify existing rows and constraints with `psql`:

```sql
SELECT "lifecycle", count(*) FROM "clients" GROUP BY "lifecycle";
SELECT conname FROM pg_constraint WHERE conrelid = 'prospect_preview_items'::regclass;
SELECT indexname FROM pg_indexes WHERE tablename IN ('prospect_workspaces', 'prospect_preview_items');
```

Then perform the new-user and existing-user claim scenarios using verified synthetic Auth0 emails. For replay, submit the consumed claim body again and expect `CLAIM_UNAVAILABLE`. For expiry, set only the synthetic row's `claimExpiresAt` into the past and expect persistent `EXPIRED`. For revocation, revoke and rotate through the admin API and prove the old digest no longer resolves. For concurrency, issue two simultaneous authenticated POSTs to `/api/v1/prospect-claims/claim`; exactly one must return success.

Before claim, exercise publish, schedule, OAuth start, Inbox email, and Inbox SMS through staging API routes and expect `PROSPECT_SIDE_EFFECT_BLOCKED` before provider calls. Keep Stripe, Postmark, Twilio, and social credentials absent or pointed at approved test/sandbox accounts. After claim the transaction changes lifecycle to `CUSTOMER`; the workspace receives no trial or paid grant and follows the existing user subscription and usage-limit rules.

Record sanitized request IDs, status codes, final lifecycle/owner, selection ordering, and database assertions. Never record raw preview or claim credentials.
