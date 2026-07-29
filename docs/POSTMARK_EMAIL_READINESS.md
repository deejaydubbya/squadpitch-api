# Postmark production email readiness

## Runtime contract

Production startup fails closed unless all of these variables are present and
valid. Keep their values in the deployment secret store; never commit or print
them.

```text
POSTMARK_SERVER_TOKEN=<production server token>
POSTMARK_MESSAGE_STREAM=outbound
NOTIFICATION_FROM_EMAIL=notifications@squadpitch.com
INBOX_EMAIL_FROM=inbox@mail.squadpitch.com
INBOX_EMAIL_REPLY_DOMAIN=mail.squadpitch.com
POSTMARK_INBOUND_WEBHOOK_SECRET=<at least 32 random characters>
INBOX_EMAIL_DAILY_CAP=50
```

`POSTMARK_MESSAGE_STREAM` must identify a Transactional stream. Notification
and Inbox sends use the same explicit stream. A send is recorded as successful
only when Postmark returns `ErrorCode: 0` and a non-empty `MessageID`.

Inbox sends create an auditable `SENDING` row before contacting Postmark, then
transition it to `SENT` or `FAILED`. Request idempotency, per-workspace caps,
Reply-To routing, RFC threading, provider errors, and inbound idempotency remain
in force. Inbound messages never create contacts or send automatic replies.

## Manual Postmark and DNS work

Perform these steps in the production Postmark account. Do not copy settings
from a staging server without verifying the selected server.

1. Create or select the SquadPitch production **Live** server. Under **API
   Tokens**, copy its Server API token into `POSTMARK_SERVER_TOKEN`.
2. Under **Sender Signatures**, add the sending domain. Copy the exact DKIM TXT
   hostname and value shown by Postmark into DNS, wait for verification, and
   verify that both configured From addresses belong to that domain or are
   separately verified Sender Signatures.
3. Configure the Postmark custom Return-Path using the exact hostname shown in
   its DNS Settings. Add that hostname as a DNS-only CNAME to
   `pm.mtasv.net`. Postmark supplies SPF for its Return-Path; do not add a
   second SPF TXT record at the same CNAME hostname.
4. Audit the domain's one existing SPF record for every other legitimate
   sender. Do not create multiple SPF records.
5. Add or review the `_dmarc` TXT record. Begin with monitoring (`p=none`) and a
   controlled reporting mailbox. Move to `quarantine` or `reject` only after
   all legitimate senders are aligned and reports are clean.
6. In **Message Streams**, confirm `outbound` (or the configured ID) is
   **Transactional**, active, and belongs to this production server. Do not use
   a Broadcast stream for product notifications or Inbox replies.
7. Open the server's **Inbound** stream. Set its inbound domain to
   `mail.squadpitch.com` (matching `INBOX_EMAIL_REPLY_DOMAIN`). Add an MX record
   for that subdomain with priority `10` pointing to
   `inbound.postmarkapp.com`. Do not replace the root domain's mailbox MX
   records.
8. Generate a new random webhook password of at least 32 characters and store
   it as `POSTMARK_INBOUND_WEBHOOK_SECRET`. In the Inbound stream settings, set
   the webhook URL using Postmark-supported HTTPS Basic authentication:

   ```text
   https://postmark:<URL-ENCODED_SECRET>@squadpitch-api.fly.dev/api/v1/webhooks/postmark/inbound
   ```

   The password must decode to the exact environment secret. Never put the URL
   in tickets, chat, source control, screenshots, or application logs.

9. Keep raw email content disabled unless it is operationally required. The
   application ignores attachment bodies and stores only bounded metadata.
10. After deployment, run the production-readiness verifier. It checks the
    server token without displaying it and requires a `Live` server with an
    HTTPS inbound webhook.

## Controlled acceptance test

Use owned test mailboxes and a non-customer conversation:

1. Send one notification and one Inbox reply. Confirm Postmark activity,
   `SENT` state, and provider message ID.
2. Reply to the Inbox message. Confirm it routes to the original conversation,
   preserves threading, reopens a closed non-spam conversation, and creates
   only one message when the webhook is retried.
3. Submit a malformed payload and an unrecognized conversation hash with valid
   authentication. Confirm safe `200` dispositions and no contact creation.
4. Submit missing/invalid authentication and confirm `403`.
5. Exercise an invalid sender or inactive recipient in a non-customer test and
   confirm the outbound record is `FAILED`, never `SENT`.
6. Confirm notification failures are marked failed and retried by the worker
   for transient provider errors.

Postmark retries non-200 inbound webhook responses; the API returns `500` only
for retryable processing/database failures and safely acknowledges permanent
malformed or unrecognized messages.
