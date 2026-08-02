# Signup, plan, Checkout, and onboarding handoff

## State transitions

```text
Free pricing CTA
  -> Auth0 signup/login
  -> /onboarding

Paid pricing CTA
  -> Auth0 signup/login
  -> /signup/continue?selectedPlan=SERVER_PLAN_KEY
  -> SignupPlanIntent.SELECTED
  -> Stripe Checkout
  -> SignupPlanIntent.CHECKOUT_CREATED
  -> signed checkout.session.completed webhook
  -> Subscription ACTIVE/TRIALING + paid tier
  -> SignupPlanIntent.ACTIVATED
  -> /onboarding
```

The supported paid browser plan keys are `STARTER` and `PRO`. `GROWTH` is a
legacy entitlement for existing Team subscriptions and `AGENCY` is assisted;
neither is accepted by self-service signup or checkout.
The API maps those keys to server-side Stripe price IDs. Price IDs and return
URLs are never accepted from the signup continuation page.

## Authority and safety

- Auth0 remains responsible for registration and sessions. An authenticated
  existing user follows the same continuation without creating another user.
- `SignupPlanIntent` stores one recoverable selection per API user. Selecting
  another plan updates that row instead of creating another intent.
- Stripe Checkout creation uses a stable idempotency key. An open session is
  resumed; an expired session advances the attempt before creating another.
- A Checkout redirect never grants access. `getEffectiveTier` remains Free
  until a signed Stripe webhook stores a real active/trialing subscription.
- Checkout cancellation, abandonment, delayed webhooks, and API errors leave
  the account usable on Free.
- The success page polls the API for up to 30 seconds. Users can continue on
  Free if webhook delivery is delayed; entitlement appears later when the
  webhook is processed.
- Workspace creation remains inside the existing onboarding flow. The handoff
  does not create a workspace, so refreshes, callbacks, and Checkout retries
  cannot duplicate one.
- Stripe event ID/timestamp ordering guards continue to make webhook retries
  and out-of-order events safe.

## Recovery paths

- **Canceled/abandoned Checkout:** revisit `/signup/continue` to resume the
  stored plan, or use onboarding immediately on Free.
- **Expired Checkout session:** the API creates one new attempt and stores it.
- **Webhook delay:** revisit `/signup/continue?checkout=success`, or continue
  onboarding; paid access is synchronized when the webhook arrives.
- **Already subscribed:** the API returns `ACTIVATED` and skips Checkout.
- **Repeated callback/refresh:** the intent upsert, Stripe idempotency key, open
  session reuse, webhook ordering guard, and existing onboarding ownership
  rules prevent duplicate effects.

## Deployment

Run the checked-in Prisma migration before the application rollout:

```powershell
npm run db:migrate
```

The API Fly release command already runs `prisma migrate deploy`. Confirm the
Stripe webhook endpoint subscribes to at least:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

No new secrets are required. Existing `APP_URL`, Stripe secret, webhook secret,
and per-tier server price IDs must pass the production-readiness verifier.
