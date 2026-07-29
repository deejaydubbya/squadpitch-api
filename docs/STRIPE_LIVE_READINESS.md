# Stripe live-mode readiness

## Runtime contract

- Production requires `STRIPE_EXPECTED_MODE=live` and an `sk_live_` secret.
- The readiness verifier retrieves all four configured prices and requires
  each object to be live-mode, active, and recurring.
- Browsers send only plan keys. The API maps `STARTER`, `PRO`, `GROWTH`, and
  `AGENCY` to server-held Price IDs.
- Checkout and Customer Portal returns must use the exact `APP_URL` origin.
- Checkout accepts an optional UUID idempotency key and scopes it to the API
  user. Signup Checkout additionally persists and resumes open sessions.
- Users with active, trialing, or past-due Stripe subscriptions cannot create
  a second subscription Checkout. Plan changes use the existing subscription;
  past-due recovery belongs in Customer Portal.
- Checkout redirects never grant entitlement. Initial purchases and plan
  changes become authoritative only after signed Stripe webhooks.
- Duplicate event IDs and older event timestamps are ignored. Active,
  trialing, past-due, unpaid, canceled, incomplete, and deleted states map
  conservatively to local access.
- Logs contain user/tier/status and Stripe object identifiers, never secret
  keys, webhook signatures, card data, or full provider payloads.

## Required environment variables

```text
STRIPE_EXPECTED_MODE=live
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_STARTER_PRICE_ID=price_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_GROWTH_PRICE_ID=price_...
STRIPE_AGENCY_PRICE_ID=price_...
APP_URL=https://app.squadpitch.com
```

Do not commit these values. Set them through Fly secrets and verify names with
`fly secrets list -a squadpitch-api`.

## Manual Stripe live-mode steps

Perform these in **live mode**, not the Dashboard test-mode toggle:

1. **Product catalog:** create/confirm one recurring monthly Price for each
   Squadpitch tier. Keep currency and tax behavior consistent. Copy the live
   `price_...` IDs into the matching Fly variables.
2. **Checkout:** enable the intended card/payment methods, collect billing
   details required by the business, configure customer emails, and confirm
   the Squadpitch branding and support links.
3. **Customer Portal:** enable payment-method updates, invoice history,
   cancellation behavior, and the exact plan-switch options Squadpitch
   supports. Do not expose legacy/test Prices.
4. **Webhook endpoint:** create
   `https://squadpitch-api.fly.dev/api/v1/billing/webhook`, select the current
   API version, and subscribe to:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, and
   `invoice.payment_failed`. Install that endpoint's live `whsec_...` value.
5. **Business profile:** confirm legal business name, public business name,
   support email/phone/site, statement descriptor, and shortened descriptor.
6. **Fraud/disputes:** review Radar defaults, dispute notifications, team
   access, and account email security/MFA.
7. **Tax:** explicitly decide whether Stripe Tax is enabled and confirm product
   tax codes, registrations, and invoice address collection with an accountant.
8. **Receipts/invoices:** review receipt branding, invoice footer, retry
   schedule, failed-payment emails, cancellation policy, and customer-facing
   terms.

Use Stripe CLI/test mode for scenario testing. Do not manufacture live charges
to verify code.

## Manual Mercury and payout steps

In Stripe **Settings > Bank accounts and scheduling**, confirm the payout
account is the intended Mercury business checking account:

1. Obtain routing/account details directly from the authenticated Mercury
   dashboard; never copy them into source, tickets, or logs.
2. Enter/verify those details only in Stripe's encrypted payout settings.
3. Confirm the Stripe legal entity and account holder match the Mercury
   account, complete any verification or micro-deposit flow, and enable payout
   change notifications.
4. Choose the payout schedule and minimum balance appropriate for refunds,
   disputes, taxes, and operating cash.
5. In Mercury, enable alerts for incoming Stripe payouts and confirm the first
   real payout by matching Stripe's payout ID/date/net amount to the Mercury
   deposit. Do not create a live payment solely for testing.
6. Restrict who can change Stripe payout details, require MFA, and document the
   internal approval/reconciliation process.

## Release verification

Run:

```powershell
npm run verify:production
npm test
```

Manually test in Stripe test mode: initial purchase, abandon/resume, duplicate
request, upgrade, downgrade, cancellation, past-due recovery, Portal return,
duplicate webhook, stale webhook, and out-of-order delivery. After production
deployment, use read-only live verification and normal customer activity rather
than synthetic live charges.
