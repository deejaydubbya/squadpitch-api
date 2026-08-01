# End-to-End Launch Testing

The launch gate has two deliberately separate layers:

- **CI/local-safe:** deterministic tests with mocked providers and no network
  side effects.
- **Live-production verification:** read-only connectivity/configuration checks
  plus operator-controlled canaries. It never charges a card, publishes to a
  public destination, sends a message, or deletes data automatically.

## CI and local commands

From `squadpitch-api`:

```text
npm run test:launch
npm run test:launch:json
npm run verify:production:no-network
```

From `squadpitch-web`:

```text
npm run test:launch
npm run test:e2e
```

The API launch runner produces a PASS/WARN/FAIL report. A missing live publish
canary is a WARN and keeps publishing skipped. Any failed journey or forbidden
live-effect switch is FAIL. The web launch command covers public landing access,
signup/login return safety, paid-plan continuation, onboarding redirects and
persistence, integration availability, and publish-error recovery. Playwright
adds a production-build browser smoke test without entering live Auth0, Stripe,
or social OAuth.

## Journey coverage

| Journey                        | Automated proof                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Landing/pricing → signup/login | Web public-access, auth-flow and signup-route tests; Playwright smoke             |
| Plan continuation              | Web plan handoff plus API billing integrity                                       |
| Workspace/onboarding           | Web redirect/persistence plus API tenant isolation                                |
| Billing entitlement            | Stripe webhook signature, ordering/dedup and entitlement integrity simulations    |
| Content generation             | Hosted AI production-verification contract and provenance/fallback classification |
| Integration state              | Capability matrix plus signed OAuth state replay/tamper/expiry tests              |
| Scheduling/publishing boundary | Publishing service state, ownership and idempotency tests; no public post         |
| Notifications/support          | Postmark/Twilio production configuration and disabled-send safety                 |
| Billing/account lifecycle      | Subscription invariants, lifecycle dry-run/isolation and audit behavior           |

Failure paths include invalid/expired OAuth state, cross-tenant references,
invalid Stripe signatures, duplicate/out-of-order Stripe events, disconnected
publishing channels, provider configuration omissions, unapproved SMS sending,
hosted AI failure/fallback warnings, and account-lifecycle isolation.

## Live-production verification

Run from `squadpitch-api` with the production environment supplied through the
approved secret mechanism:

```text
npm run verify:production
npm run verify:ai-production
npm run verify:observability
npm run verify:backup-recovery
```

The production verifier performs read-only configuration and connectivity
checks. Review its PASS/WARN/BLOCKED/FAIL output and retain the JSON report as
launch evidence. A successful health probe is not proof that signup, billing,
email, SMS or provider approval is ready.

### Live-effect rules

1. **Billing:** never automate a live card charge. Verify Stripe mode, prices,
   webhook delivery and entitlement using provider metadata/read-only API
   checks. Any checkout journey uses Stripe test mode or a human-controlled
   documented live transaction followed by reconciliation/refund.
2. **Publishing:** skip live publishing unless
   `LAUNCH_PUBLISH_CANARY_DESTINATION` identifies a private, approved canary
   destination. Merely setting it does not publish; an operator must invoke and
   observe a single canary, then verify idempotency before cleanup.
3. **Email/SMS:** readiness checks inspect config/account state without sending.
   A send requires the existing explicit provider enablement/compliance gates
   and an operator-approved canary recipient.
4. **Destructive lifecycle:** test preview/dry-run and authorization in
   automation. Never set `LAUNCH_DESTRUCTIVE_ACTIONS=true`; the launch runner
   fails if present. A real delete is a separately approved manual exercise on
   a disposable canary account.
5. **AI:** require provenance source `squadpitch-ai`. Python-internal or Node
   fallback is WARN; unusable output or fallback on a no-fallback operation is
   FAIL.

`LAUNCH_AUTO_CHARGE_CARDS=true` is also forbidden and fails the launch report.
No credentials, card data, tokens, message bodies, or customer identifiers may
appear in test reports.

## Tracked recovery blocker

| Field                   | Value                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item                    | Enable PITR or migrate to managed Postgres before public acquisition                                                                               |
| Owner                   | Squadpitch product/engineering owner                                                                                                               |
| Priority                | P0 before public acquisition                                                                                                                       |
| Status                  | Open; snapshot-only recovery accepted for controlled beta                                                                                          |
| Accepted temporary risk | Worst-case Postgres data loss may approach one daily snapshot interval; full application recovery remains unproved                                 |
| Completion trigger      | PITR/equivalent enabled with retention documented, isolated restore tested, verifier `PITR_CONFIRMED: PASS`, and public-acquisition gate unblocked |
| Review milestone        | Review by 2026-08-15 and at every beta expansion decision                                                                                          |
| Plan                    | [`managed-postgres-migration.md`](managed-postgres-migration.md)                                                                                   |

The gate may report `CONTROLLED_BETA_ALLOWED_WITH_ACCEPTED_WARNING` when all
other evidence is complete. It must report `PUBLIC_ACQUISITION: BLOCKED` until
PITR is proven.

## Live acceptance checklist

- [ ] Landing and pricing load from an unauthenticated browser.
- [ ] Login and signup redirect only to approved same-origin continuations.
- [ ] A canary signup preserves the chosen paid plan through Auth0.
- [ ] New user reaches onboarding and can create exactly one owned workspace.
- [ ] Tenant A cannot access Tenant B through API or UI.
- [ ] Stripe live configuration and webhook endpoint pass read-only checks.
- [ ] Simulated duplicate/out-of-order webhooks preserve entitlement state.
- [ ] Hosted content generation reports `source=squadpitch-ai`; fallbacks are visible.
- [ ] Integration UI status matches actual provider approval/capability.
- [ ] Scheduling stops at the publishing boundary without an approved canary.
- [ ] Postmark/Twilio readiness passes without sending.
- [ ] Support/contact route and notification preferences are reachable.
- [ ] Lifecycle preview lists impact without mutating data.
- [ ] Sentry/Fly dashboard receives safe request/trace correlation.
- [ ] Launch report and manual provider evidence have named owner approval.
