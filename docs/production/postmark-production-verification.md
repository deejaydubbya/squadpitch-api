# Postmark Production Verification

**Status: EXTERNAL VERIFICATION REQUIRED.** Credentials alone are not evidence.
Do not enable any readiness flag until its evidence row below is satisfied.

## Repository controls

Squadpitch uses one central verified sender, a Transactional message stream,
plain-text and HTML bodies, bounded attachments, RFC reply/thread headers,
pre-send `SENDING` persistence, terminal `SENT`/`FAILED` status, safe error
classification, request idempotency, inbound Message-ID idempotency, and
workspace-scoped reply routing. Provider tokens, message bodies, addresses, and
webhook secrets are redacted from diagnostics. Marketing mail is not sent by
this path; product/inbox messages are transactional.

## Dashboard and DNS checklist

- [ ] Production Postmark account is approved and its selected server is Live.
- [ ] `POSTMARK_SERVER_TOKEN` belongs to that server; never paste it into evidence.
- [ ] `POSTMARK_MESSAGE_STREAM` exists, is active, and is Transactional.
- [ ] Both From addresses are covered by a verified sender/domain.
- [ ] Postmark DKIM hostname/value verifies.
- [ ] The custom Return-Path CNAME verifies and SPF alignment passes.
- [ ] There is one valid SPF record for each hostname, not competing records.
- [ ] DMARC exists; policy and report mailbox are approved by the operator.
- [ ] Tracking domain is either deliberately disabled or HTTPS-valid and verified.
- [ ] Link/open tracking behavior matches the transactional privacy decision.
- [ ] `INBOX_EMAIL_REPLY_DOMAIN` has the Postmark inbound MX without replacing root-mail MX.
- [ ] Inbound stream webhook is HTTPS and points to `/api/v1/webhooks/postmark/inbound`.
- [ ] Webhook Basic-auth password exactly matches the secret store; URL is not captured in evidence.
- [ ] Webhook activity shows successful 2xx requests and no unexplained retries.
- [ ] Suppressions, bounces, spam complaints, and inactive recipients are monitored.

## Safe synthetic test

Use a dedicated non-customer workspace, contact, conversation, and mailbox. Put
`[SYNTHETIC CANARY]` in the conversation subject or contact name. Supply the
runtime-only variables below through an approved shell/secret path; never save
the token or values in source or command history.

`POSTMARK_CANARY_API_BASE_URL`, `POSTMARK_CANARY_ACCESS_TOKEN`,
`POSTMARK_CANARY_WORKSPACE_ID`, `POSTMARK_CANARY_ALLOWED_WORKSPACE_ID`,
`POSTMARK_CANARY_CONVERSATION_ID`, `POSTMARK_CANARY_RECIPIENT`, and
`POSTMARK_CANARY_ALLOWED_RECIPIENT` are required. The two workspace values and
two recipient values must match exactly. The token must resolve the synthetic
owner and is never printed.

1. Run `npm run verify:postmark-delivery -- send`.
2. Confirm the Gmail recipient receives the message in Inbox; also record spam
   placement, authentication results, Postmark activity, provider ID presence,
   and Squadpitch `SENT` state.
3. Reply without removing the correlation marker.
4. Run `npm run verify:postmark-delivery -- verify <correlation-id>`.
5. Retry the exact inbound event from Postmark. Run verify again; it must still
   report exactly one outbound and one inbound message.
6. With synthetic addresses only, test inactive recipient/bounce and verify
   Squadpitch records `FAILED`, classification, and no false delivery.
7. Clearly tag/archive synthetic records after evidence capture. The tool does
   not delete data.

## Evidence required for flags

| Flag | Keep false until | Durable evidence |
|---|---|---|
| `POSTMARK_ACCOUNT_APPROVED` | Account approved and production server Live | Date, operator, server ID fingerprint/name (not token), dashboard screenshot/reference |
| `POSTMARK_SENDER_VERIFIED` | Sender/domain, DKIM, Return-Path/SPF, and applicable DMARC checks pass | DNS check output and Postmark verified state with no secret values |
| `POSTMARK_DELIVERY_VERIFIED` | Gmail outbound arrives, reply returns to exactly one intended conversation, duplicate retry stays deduplicated, and failure state is visible | Correlation ID, sanitized message/provider IDs, timestamps, expected counts, inbox/spam result |

Only after each row is satisfied may an operator set that specific flag through
the existing production configuration path. Rerun targeted tests, production
readiness, and production health afterward. Gmail/Microsoft connected-mailbox
sending remains intentionally unavailable.
