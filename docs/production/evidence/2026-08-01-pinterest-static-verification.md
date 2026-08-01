# Pinterest static production verification — 2026-08-01

Final classification: **AVAILABLE - production verified for image Pin publishing**

Pinterest Standard access, exact redirect URI, minimum scopes, encrypted token storage, continuous token refresh, board operations and image Pin publishing are implemented.

Pre-deployment evidence:

- Pinterest-focused and OAuth/publishing security tests: 46 passed.
- Full API suite: 1,645 passed and 13 skipped across 160 test files.
- Prisma schema validation: passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- Pinterest readiness verifier: passed locally with the production host selected.
- Added-line secret-pattern scan: no findings. Gitleaks is enforced by the repository security workflow and must pass after push.
- Fly secret-name inspection: Pinterest credential variables exist only on `squadpitch-api`.
- The prior sandbox switch was detected and a production-host value was staged for the API deployment.

Post-deployment evidence:

- Commit `0bea2a6` passed GitHub CI and the Security/Gitleaks workflow.
- The Fly deployment completed successfully on `squadpitch-api`.
- Prisma reports 68 migrations and an up-to-date production schema, including `20260801_add_pinterest_refresh_token_expiry`.
- Both API machines report passing Fly health checks; `/health` and `/ready` pass with database, Redis, and workers healthy.
- The deployed `npm run verify:pinterest` result is PASS, including exact redirect URI and production Pinterest API host selection.
- The broader networked production verifier reports `READY_WITH_WARNINGS`: 32 PASS, 3 WARN, 20 BLOCKED, 0 FAIL. Warnings are the intentionally disabled Twilio/SMS capability; blocked evidence requires the existing authenticated canary inputs and optional worker health URL and is unrelated to Pinterest.

Manual production-canary evidence:

- A dedicated synthetic Squadpitch account completed production OAuth with only the expected user-account, board and Pin permissions.
- Board listing succeeded and `[SYNTHETIC CANARY] Squadpitch Pinterest Test` was created or selected.
- One non-customer image-only Pin was published to the correct board.
- Squadpitch stored the published state and provider Pin ID.
- Refreshing created no duplicate.

The evidence is also recorded in `scripts/pinterest-readiness/evidence.json`. No customer content, credentials, tokens, authorization codes, provider IDs or user identifiers are recorded. Video Pins, Pinterest comments and Pinterest analytics remain `UNAVAILABLE`.
