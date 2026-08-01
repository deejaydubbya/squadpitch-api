# Pinterest static production verification — 2026-08-01

Classification before live canary: **WARN**

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

The remaining evidence is a human-controlled OAuth and single image Pin test using the dedicated synthetic Pinterest account. No customer content, credentials, tokens, authorization codes, or user identifiers are recorded here.
