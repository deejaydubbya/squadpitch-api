# SMS disabled runbook

## Current state

SMS is intentionally unavailable because the Twilio provider account is suspended.
The authoritative server state is `availability=disabled`,
`status=unavailable`, and `reason=twilio_account_suspended`. Customer-facing copy
must say only **SMS — Temporarily unavailable**.

This state applies to the API, inbox, notifications, workers, web application,
automations, and any legacy saved SMS action. Email, browser push, in-app
notifications, and non-SMS inbox behavior are unaffected.

## Enforcement

- Direct inbox and test sends return `SMS_UNAVAILABLE` with HTTP 503 before any
  database write, billing reservation, queue creation, or provider call.
- Notification dispatch never creates an SMS log or BullMQ job.
- A legacy `send-notification-sms` job is marked failed with `SMS_UNAVAILABLE` and
  completes without throwing, preventing provider calls and retries.
- Reply-action capability data always marks SMS unavailable. Existing schemas keep
  SMS enum values only for backward compatibility.
- Valid Twilio inbound and delivery callbacks are signature-verified and safely
  acknowledged without changing contacts, conversations, messages, leads, or jobs.
  Invalid signatures remain rejected.
- Blocked attempts emit redacted, grouped operational telemetry with a 15-minute
  per-surface cooldown. Phone numbers and message bodies are never attached.

## Secrets and queues

`SMS_SENDING_ENABLED` must remain false. The outbound-only
`TWILIO_ACCOUNT_SID` and `TWILIO_FROM_NUMBER` Fly secrets were removed.
`TWILIO_MESSAGING_SERVICE_SID` was not present. `TWILIO_AUTH_TOKEN` is quarantined
for signature validation only and must remain available while the signed webhook
endpoints remain deployed; removing it would weaken signature validation. Secret
values must never be printed.

Run `npm run verify:sms-disabled` inside the production API to report aggregate
waiting, delayed, active, failed, retrying, and repeatable SMS job counts. The
command reads job names only and never prints job payloads or recipient data. Do not
delete customer conversations or message history.

## Reactivation prerequisites

SMS must not be re-enabled without explicit approval after all of these are true:

1. Twilio suspension and disputed balance are resolved.
2. Account ownership and administrator access are confirmed.
3. Credentials are rotated.
4. A2P registration is approved.
5. A Messaging Service is configured and a sender is assigned.
6. Inbound and delivery webhook URLs are configured.
7. Signature validation is verified.
8. STOP, START, and HELP behavior is verified.
9. Consent UI is reviewed and verified.
10. Outbound, inbound, and delivery-callback tests pass.
11. Sentry alert delivery and the production canary pass.
12. An explicit feature-flag re-enable change is reviewed and approved.
