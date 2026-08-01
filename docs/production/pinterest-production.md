# Pinterest production integration

Last reviewed: 2026-08-01

## Production contract

- Pinterest developer access: Standard access (operator-confirmed).
- Redirect URI: `https://app.squadpitch.com/oauth/PINTEREST/callback`.
- Scopes: `user_accounts:read`, `boards:read`, `boards:write`, `pins:read`, `pins:write`.
- Credentials and redirect configuration are server-only on `squadpitch-api`.
- Access and refresh tokens are encrypted at rest with AES-256-GCM.
- Continuous refresh tokens are rotated and persisted when Pinterest returns a replacement.
- Access-token expiry and refresh-token expiry are persisted independently.

## Supported capabilities

- OAuth connection, board listing with pagination, board creation and board selection.
- Image Pin creation with provider Pin ID persistence.
- Proactive token refresh, per-process coalescing plus a cross-machine Redis lease, and one safe refresh/retry after a Pinterest authorization failure.

Video Pins, comments inbox and Pinterest analytics are unavailable. Image Pin publishing is `AVAILABLE` after the controlled production canary was manually confirmed on 2026-08-01.

## Static production evidence — 2026-08-01

- Fly configuration metadata confirms all Pinterest variable names are deployed on `squadpitch-api`.
- The production redirect URI and production API host are enforced by `npm run verify:pinterest`.
- The refresh and publishing adapters are registered.
- OAuth state is HMAC-signed, random, expires after ten minutes, and is single-use through Redis. Callback ownership is rechecked against the authenticated user and workspace.
- Automated verification does not perform OAuth and never creates a Pin.

## Completed production canary - 2026-08-01

Using the dedicated synthetic Squadpitch account, the operator completed production OAuth with the expected minimum scopes, loaded boards, created or selected `[SYNTHETIC CANARY] Squadpitch Pinterest Test`, and published one non-customer image-only Pin. Exactly one Pin appeared on the correct board, Squadpitch recorded the post as published, the provider Pin ID was stored, and refreshing created no duplicate.

Durable machine-readable evidence is stored in `scripts/pinterest-readiness/evidence.json` and enforced by `npm run verify:pinterest`. This evidence applies only to image Pin publishing; it does not expand video, comments or analytics support.
