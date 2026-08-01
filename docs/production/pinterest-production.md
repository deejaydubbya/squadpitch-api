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

Video Pins, comments inbox and Pinterest analytics are unavailable. Image Pin publishing remains beta until the controlled live canary below is manually confirmed.

## Static production evidence — 2026-08-01

- Fly configuration metadata confirms all Pinterest variable names are deployed on `squadpitch-api`.
- The production redirect URI and production API host are enforced by `npm run verify:pinterest`.
- The refresh and publishing adapters are registered.
- OAuth state is HMAC-signed, random, expires after ten minutes, and is single-use through Redis. Callback ownership is rechecked against the authenticated user and workspace.
- Automated verification does not perform OAuth and never creates a Pin.

## Remaining manual canary

Use a dedicated synthetic account to complete OAuth, load boards, create or select `[SYNTHETIC CANARY] Squadpitch Pinterest Test`, and publish one synthetic image Pin. Confirm the Pin and stored provider ID, and verify no duplicate was created. Do not mark live publishing verified until this is complete.
