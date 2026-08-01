# AI production verification

Run one authenticated, read-only command to see whether deployed AI operations
accepted the hosted `squadpitch-ai` result or a Node/Python fallback:

```bash
npm run verify:ai-production
```

The standalone verifier calls an admin/developer-only endpoint on
`squadpitch-api`. The production canary can execute the same fixed synthetic
operations through its exact-workspace allowlist and normal owner session. The
API uses the normal signed Node-to-Python control plane. It never publishes,
sends messages, invokes social integrations, or creates drafts.

## Status meanings

- `PASS`: a usable result was accepted from `squadpitch-ai` with no fallback.
- `WARN-PYTHON`: Python returned the accepted result but internally used a
  deterministic/model fallback.
- `WARN-NODE`: a usable Node/local result was accepted, including intentional
  local or shadow execution.
- `FAIL`: no usable result was returned.
- `SKIPPED`: the operation cannot currently be verified safely. It is never
  counted as a pass.

Warnings exit zero by default. Any failure exits one. `--strict` also makes
warnings exit one.

## Configuration

Set these without committing their values:

```bash
SQUADPITCH_VERIFY_BASE_URL=https://squadpitch-api.fly.dev
SQUADPITCH_VERIFY_TOKEN=<Auth0 access token with admin or developer role>
SQUADPITCH_VERIFY_WORKSPACE_ID=<dedicated verification workspace id>
```

Alternatively, use the complete `app.squadpitch.com` Cookie request header:

```bash
SQUADPITCH_VERIFY_BASE_URL=https://app.squadpitch.com
SQUADPITCH_VERIFY_COOKIE=<local session Cookie header>
SQUADPITCH_VERIFY_WORKSPACE_ID=<dedicated verification workspace id>
```

The token or cookie is sent only as authentication metadata and is never
included in results or reports.

Human-readable output:

```bash
npm run verify:ai-production
```

Machine-readable output:

```bash
npm run --silent verify:ai-production:json
```

Strict mode:

```bash
npm run verify:ai-production:strict
```

Run the deterministic provenance suite:

```bash
npm run test:ai-provenance
```

## Operations

The current endpoint verifies:

- Campaign Ops using a proposal-only synthetic snapshot.
- Retrieval using a synthetic, tenant-scoped snapshot and citations.
- Action Proposal in explicit dry-run mode with `persistence=false`.
- Autopilot ranking using two synthetic, non-persistent candidates.
- Brand Quality using sanitized synthetic copy.

Every operation carries a request-derived trace ID through the signed envelope.
The canary requires all returned provenance trace IDs to correlate. A hosted
PASS requires at least one usable `source=squadpitch-ai` result; intentional
shadow/local results retain their real source and execution mode.

To add an operation, add a fixed read-only adapter to
`domains/aiPlatform/productionVerification.service.js`, validate a minimally
usable domain result, and add classifier/orchestration tests. Never use a
customer payload or an operation with publishing, billing, messaging, or
integration side effects.

## Trace investigation

Copy the trace ID printed for a warning or failure, then search both services:

```bash
fly logs -a squadpitch-api
fly logs -a squadpitch-ai
```

The same provenance also appears in AI Operations Center trace pointers.
