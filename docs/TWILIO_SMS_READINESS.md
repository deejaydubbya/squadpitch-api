# Twilio production SMS readiness

## Current release posture

SMS must remain blocked until the correct US messaging compliance model is
approved. SquadPitch sends messages on behalf of customer businesses, so this
likely qualifies as an **ISV/reseller** use case rather than messaging solely
for SquadPitch. Confirm the architecture with Twilio Compliance before
registration. Do not register every customer's traffic under SquadPitch's own
brand unless Twilio explicitly confirms that model.

Keep these flags false until the dashboard shows the applicable Customer
Profile, Brand, and Campaign as approved:

```text
SMS_A2P_APPROVED=false
SMS_SENDING_ENABLED=false
```

The shared SMS provider enforces both flags for Inbox, notifications, and test
sends. No path may bypass them.

## Production environment

Store values in the deployment secret store and never log them:

```text
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=<secret>
TWILIO_FROM_NUMBER=+1...
TWILIO_MESSAGING_SERVICE_SID=MG...
TWILIO_INBOUND_WEBHOOK_URL=https://squadpitch-api.fly.dev/api/v1/inbox/webhooks/twilio/inbound
TWILIO_STATUS_CALLBACK_URL=https://squadpitch-api.fly.dev/api/v1/inbox/webhooks/twilio/status
INBOX_SMS_DAILY_CAP=50
INBOX_SMS_MAX_CHARS=480
SMS_A2P_APPROVED=false
SMS_SENDING_ENABLED=false
```

Production boot rejects an enabled configuration unless the approval flag,
credential shapes, E.164 sender, Messaging Service, and credential-free HTTPS
webhook URLs are valid.

## Manual Twilio and compliance work

1. In **Twilio Console → Messaging → Regulatory Compliance → Onboarding**,
   identify SquadPitch as an ISV/reseller if Twilio confirms that customer
   businesses are the message senders.
2. Complete SquadPitch's Primary Customer Profile. For customer messaging,
   create the appropriate Secondary Customer Profile using each customer's
   real legal and tax information; then register that customer's Brand and
   Campaign. Never reuse or fabricate business data.
3. Document the campaign use case, opt-in workflow, sample messages, privacy
   policy, terms, expected volume, and opt-out/help behavior exactly as users
   experience them. Keep proof of consent.
4. Wait until every required Profile, Brand, and Campaign status is approved.
   A submitted or pending status is not approval.
5. Create/select the production **Messaging Service** and add only approved
   senders to its Sender Pool. Associate the approved A2P Campaign with that
   service. Record its `MG...` SID as `TWILIO_MESSAGING_SERVICE_SID`.
6. Under the Messaging Service's integration settings, configure incoming
   messages to POST form data to `TWILIO_INBOUND_WEBHOOK_URL`.
7. Configure the delivery status callback as `TWILIO_STATUS_CALLBACK_URL`.
   Both endpoints validate `X-Twilio-Signature` with the exact configured URL.
8. Review **Opt-Out Management** before enabling Advanced Opt-Out. Confirm
   STOP-family, START/UNSTOP, and HELP keywords and responses identify the
   correct sender and match the registered campaign. Twilio notes that
   Advanced Opt-Out cannot be disabled without Support after activation.
9. Verify that `OptOutType=STOP` reaches SquadPitch. The API also recognizes
   standard English STOP-family commands, persists the opt-out on every
   matching contact, and returns `500` if persistence fails so Twilio retries.
   SquadPitch deliberately does not clear its stored opt-out automatically on
   START; re-consent needs an explicit, audited product workflow.
10. Configure Twilio Console access controls, MFA, least privilege, spend
    limits, usage alerts, geo permissions, and credential rotation ownership.
11. Run the production-readiness verifier. Keep
    `SMS_SENDING_ENABLED=false` if any check or manual compliance item is
    incomplete. Only after approval evidence is reviewed should an operator set
    `SMS_A2P_APPROVED=true`; enable sending separately during a controlled
    release.

## Runtime guarantees and acceptance tests

- First outbound contact includes `Reply STOP to opt out.`.
- Every send is idempotent, capped per workspace/day, length-capped, and written
  as `SENDING` before the provider call.
- Provider rejection, timeout, missing SID, and delivery callbacks for
  `failed`, `undelivered`, or `canceled` produce `FAILED`, never successful
  delivery.
- Repeated delivery callbacks are idempotent. A late positive callback cannot
  overwrite a recorded terminal failure.
- Missing, invalid, or body-tampered webhook signatures are rejected before
  database access.
- STOP is fail-closed: after an opt-out, outbound sending is refused. Duplicate
  STOP events remain safe.
- HELP/START responses are owned by the configured Twilio opt-out policy;
  application code does not improvise compliance messages.

Before enabling customer traffic, test only with owned numbers: disabled flags,
each signature failure, STOP and localized `OptOutType=STOP`, duplicate STOP,
HELP, provider rejection, timeout, duplicate/reordered status callbacks,
daily/length caps, and a successful accepted-to-delivered lifecycle.
