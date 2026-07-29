# Social and third-party integration production audit

`GET /api/v1/integrations/capabilities` is the machine-readable source of
truth. Status applies per capability; successful OAuth does not prove publish,
analytics, comments, webhook, or production-review availability.

## Capability matrix

| Provider                | Overall     | Connect / recovery | Publish / media       | Comments or reviews | Analytics   | Webhook     | Production gate             |
| ----------------------- | ----------- | ------------------ | --------------------- | ------------------- | ----------- | ----------- | --------------------------- |
| Facebook Pages          | BETA        | BETA               | BETA / BETA           | BETA                | BETA        | UNAVAILABLE | Meta App Review             |
| Instagram Business      | BETA        | BETA               | BETA / BETA           | BETA                | BETA        | UNAVAILABLE | Meta App Review             |
| LinkedIn personal       | AVAILABLE   | AVAILABLE          | AVAILABLE / BETA      | UNAVAILABLE         | UNAVAILABLE | UNAVAILABLE | Available products only     |
| LinkedIn organization   | BETA        | BETA               | BETA / BETA           | COMING_SOON         | COMING_SOON | UNAVAILABLE | Community Management review |
| Threads                 | AVAILABLE   | AVAILABLE          | AVAILABLE / AVAILABLE | AVAILABLE           | AVAILABLE   | UNAVAILABLE | Documented approval         |
| YouTube                 | BETA        | BETA               | BETA / BETA           | BETA                | BETA        | UNAVAILABLE | Google OAuth verification   |
| Google Business Profile | BETA        | BETA               | UNAVAILABLE           | BETA reviews        | UNAVAILABLE | UNAVAILABLE | GBP API access              |
| TikTok                  | BETA        | BETA               | BETA / BETA           | UNAVAILABLE         | UNAVAILABLE | UNAVAILABLE | TikTok app/content audit    |
| Pinterest               | AVAILABLE   | AVAILABLE          | AVAILABLE / BETA      | UNAVAILABLE         | UNAVAILABLE | UNAVAILABLE | Standard access             |
| X                       | BETA        | BETA               | BETA / BETA           | UNAVAILABLE         | UNAVAILABLE | UNAVAILABLE | API tier/rate limits        |
| Reddit                  | COMING_SOON | COMING_SOON        | COMING_SOON           | COMING_SOON         | COMING_SOON | UNAVAILABLE | Not started                 |

“AVAILABLE” means the code and documented provider approval posture support the
listed capability. It does not bypass missing deployment configuration,
workspace authorization, token/scopes, provider outages, quotas, or revocation.
“BETA” must be presented as Beta in the UI.

## Security and state transitions

- OAuth state is HMAC-SHA256 signed, expires after ten minutes, contains a
  cryptographic nonce, and is single-use through Redis. If Redis cannot prove
  the nonce exists, verification fails closed.
- OAuth completion rechecks that the authenticated identity owns the workspace
  encoded in state before exchanging or storing credentials.
- Redirect URIs are server configuration, not caller input. Production
  configuration must use exact HTTPS callbacks registered with each provider.
- Access and refresh tokens are encrypted before database storage and never
  returned by connection formatters.
- Refresh-capable providers use the central token-refresh service. Permanent
  failures transition to `NEEDS_RECONNECT`; expired, revoked, or error
  connections cannot publish.
- Disconnect deletes stored tokens, disables the channel, and writes an audit
  record. Reconnect performs a fresh authorization and replaces credentials.
- Provider errors cannot silently fall back to simulator publishing. Meta demo
  publishing must remain disabled in production.
- Workspace ownership is checked before connect, callback completion,
  disconnect, validation, location/board selection, comment sync, and publish.

## Manual provider-dashboard work

Never infer approval from a successful test-user OAuth flow. Record approval
dates, products/scopes, app IDs, reviewer correspondence, and screenshots in
the release evidence packet.

### Meta: Facebook and Instagram

1. Confirm the production app is Live and Business Verification is complete.
2. Verify every requested Page and Instagram Business permission has the
   required production access.
3. Confirm exact redirect URIs, privacy policy, terms, data-deletion URL, app
   domains, and reviewer/test-user access.
4. Keep both providers Beta until dashboard evidence matches requested scopes.
   Private DMs remain out of scope.

### LinkedIn

1. Verify the app and organization association and the personal Sign In/Share
   products.
2. For organization publishing, comments, and analytics, complete Community
   Management Development and Standard tier review as applicable.
3. Verify calls use a currently supported Marketing API version.

### Google and YouTube

1. Verify OAuth consent branding, verified domains, exact redirect URIs,
   support contacts, and publishing status.
2. Submit verification for the sensitive YouTube and `business.manage` scopes
   actually requested.
3. Enable YouTube Data API and request Google Business Profile API access
   separately. Configure quotas and alerts.

### TikTok

Verify Login Kit and Content Posting products, exact redirect URI, website,
terms, privacy policy, and URL ownership. Complete app review and the Content
Posting API audit; until then publishing remains Beta.

### Pinterest

Confirm Standard access, redirect URI, scopes, and selected-board flow. Image
Pin publishing is Available; unproven video variants remain Beta.

### X

Confirm callback URL, OAuth scopes, project environment, write access, spend
cap, and the paid tier required for expected volume. Keep Beta until quota and
economics are verified.

### Threads

Confirm production permissions, redirect URI, deauthorization/data-deletion
callbacks, and live-account publish, insight, and reply-polling evidence.

### Reddit

Do not configure or advertise customer OAuth. There is no backend OAuth or
publishing adapter; the UI remains Coming Soon.

## Release evidence still required

Dashboard approval cannot be proven from repository code. A release owner must
supply current evidence for Meta, LinkedIn organization, YouTube/Google
Business, TikTok, Pinterest, X tier, and Threads. Absent, pending, expired, or
contradictory evidence downgrades the affected capability to BETA or
UNAVAILABLE.
