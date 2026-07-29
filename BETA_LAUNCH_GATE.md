# Squadpitch Beta Launch Gate

**Current decision: NOT READY — MANUAL EVIDENCE INCOMPLETE.**

Passing builds and tests are necessary but not sufficient. The beta owner may
advance only when every P0 row below has a linked evidence artifact, named owner,
timestamp, environment, release SHA and explicit result. Accepted warnings must
be documented with impact, mitigation, owner and expiry; an undocumented
warning is a failed gate.

## P0 acceptance criteria

| Criterion | Required evidence | Current repository evidence | Gate |
| --- | --- | --- | --- |
| Production verifier | `npm run verify:production` report has no FAIL and only signed-off warnings | Verifier, JSON output and launch checks implemented | Manual production run required |
| Fresh signup | New external browser session creates a normal Auth0 user and returns safely | Signup route/auth return tests | Manual production evidence required |
| Free onboarding and first value | Free user creates owned workspace, adds real source data and reaches a useful generated draft | Onboarding, workspace and generation tests | Manual timed journey required |
| Paid checkout/webhook/entitlement | Human-controlled live or test-mode checkout; signed webhook; correct entitlement; no duplicate regression | Stripe mode, signature, ordering and billing-integrity tests | Manual Stripe evidence required |
| Customer Portal | Correct customer opens portal and returns to approved origin; cancellation state reconciles | Portal/billing code and redirect safety | Manual portal evidence required |
| Email | Verified sender/stream, real canary delivery and inbound/reply path where applicable | Postmark safety and webhook tests | Manual Postmark delivery evidence required |
| SMS | Approved compliant A2P/ISV path passes canary, or SMS is clearly unavailable everywhere | Twilio gates, STOP, signature and delivery-state tests | Manual approval/unavailable screenshot required |
| Backup and restore | PITR/backup configured and isolated restore completed within target RPO/RTO | Backup inventory, validator and restore checklist | Real restore drill required |
| Sentry alerts | Web/API events symbolicated and P0/P1 alerts reach launch/on-call destination | Sentry integration, alert catalog and runbook | Manual alert-delivery evidence required |
| No dead core controls | Owner walkthrough confirms every core CTA completes, explains disabled state, or is removed | Build, launch suite and honest capability labels | Manual browser walkthrough required |
| Integrations accurately labeled | Capability/API/UI statuses match provider approval and real functionality | Central capability matrix and Beta/Coming Soon UI | Provider dashboard evidence required |
| Account cancellation/deletion | Cancellation, export, archival/deletion preview, retention and reactivation behavior understood | Lifecycle service, audit and isolation tests | Manual policy/journey sign-off required |
| Production canary | Normal non-admin synthetic identity completes canary with no FAIL and reviewed WARNs | Allowlisted canary endpoint and human/JSON runner | Synthetic account and live run required |
| Tenant isolation | Cross-workspace reads/writes rejected across core resources | Tenant and workspace-lifecycle isolation suites | Automated pass required on release SHA |

## Cleanup audit findings

Resolved in this pass:

- Removed the global Meta demo-publish shortcut that could synthesize a
  Facebook/Instagram `PUBLISHED` result when a runtime flag was enabled.
- Removed the unused legacy `ADMIN_USER_IDS` middleware and configuration.
- Reviewer/demo UI flags now return false in production, and the Meta demo build
  argument was removed from the production web image.
- Production publishing continues through real provider adapters only.
- Simulator routes remain denied in production and are not presented as live
  customer capabilities.
- Integration availability is centrally classified as AVAILABLE, BETA,
  COMING_SOON or UNAVAILABLE.

Accepted non-P0 code markers:

- Provider implementations and future industry enrichment contain TODOs for
  features that are unavailable or gated; they must not be described as live.
- Localhost values exist only in development examples and explicit SSRF/CORS
  rejection logic. Production configuration validation rejects localhost.
- Seed scripts remain operator-only utilities and are not required for customer
  signup or application boot. `seedFlags.js` in the release command is
  idempotent configuration seeding, not customer/demo data.
- Admin console placeholder panels are internal-only and do not qualify as beta
  customer functionality.

Before each release, run:

```text
# squadpitch-api
npm run verify:beta-gate
npm run test:launch
npm run verify:production
npm run canary:production

# squadpitch-web
npm run test:launch
npm run build
```

Store evidence references through the documented `BETA_GATE_*_EVIDENCE`
variables when generating the JSON gate report. Values should be artifact IDs or
restricted links, never credentials or customer data.

## Controlled rollout

### Stage 0 — owner-only validation

- One release SHA, production verifier, restore drill, alert-delivery test and
  synthetic canary all reviewed by the launch owner.
- Complete fresh Free and paid journeys using controlled identities.
- Keep automated publishing, SMS and optional integrations off unless their P0
  evidence is complete.
- Exit only when every P0 criterion is PASS or has an explicitly accepted,
  time-bounded warning that does not affect core value or safety.

### Stage 1 — 3–5 design partners

- Hand-select trained users with direct support access and clear beta terms.
- Enable only proven industries, plans and integration capabilities.
- Daily review of 5xx, auth, billing, queue, publish, email/SMS, OAuth and AI
  fallback dashboards; run canary before/after each release.
- No public acquisition. Roll back or pause onboarding on any tenant, billing,
  data-loss or duplicate-publish incident.

### Stage 2 — 10–25 beta users

- Admit in cohorts, confirm support capacity and measure signup-to-first-value.
- Require one stable week at Stage 1 with no open P0 and bounded P1 rate.
- Exercise cancellation and lifecycle paths, monitor provider quotas and
  reconcile billing daily.
- Expand integrations only when their capability-specific approval and canary
  evidence exists.

### Stage 3 — public acquisition

- Require two stable weeks at Stage 2, completed restore test, working alert
  escalation, acceptable first-value conversion and no unresolved P0.
- Publish honest plan, channel, SMS and beta limitations.
- Establish release freeze/rollback ownership and staffed incident coverage for
  the acquisition window.
- Continue canaries and launch reports; public availability is reversible and
  does not relax any safety gate.
