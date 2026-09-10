# Turning on payments

Everything on our side is written and tested. What is missing is four values
that only exist in your Razorpay dashboard, and one test event. Until they are
set the dashboard tells buyers "Payments aren't switched on yet" rather than
failing — so this is safe to leave half-done, but nobody can pay.

## 1. Keys

Razorpay dashboard → Settings → API Keys → Generate. You get a key id and a
secret; the secret is shown once.

```sh
railway variables --set "RAZORPAY_KEY_ID=rzp_live_xxx" --set "RAZORPAY_KEY_SECRET=xxx"
```

Use the `rzp_test_` pair first if you want to rehearse — the code does not care
which, and test keys make test payments against test plans.

## 2. Webhook secret

Razorpay dashboard → Settings → Webhooks → Add. 

- URL: `https://erasezo.com/api/webhooks/razorpay`
- Secret: make one up, long and random
- Events: `subscription.activated`, `subscription.charged`,
  `subscription.resumed`, `subscription.authenticated`, `subscription.halted`,
  `subscription.pending`, `subscription.cancelled`, `subscription.completed`,
  `subscription.paused`

Then the same secret here:

```sh
railway variables --set "RAZORPAY_WEBHOOK_SECRET=the-same-secret"
```

Without this the endpoint rejects everything with 401, which is deliberate:
the body of an unsigned request is an attacker-supplied instruction to grant a
paid plan.

## 3. Plans

Create each paid plan in Razorpay (Subscriptions → Plans) with the same price
the Control Room shows, then paste its `plan_...` id into Control Room →
Plans → Edit → Razorpay plan id. The id is never sent to browsers — `/api/plans`
deliberately omits it.

A plan without an id returns `plan_not_linked` and the buyer is told the plan
isn't connected to billing yet, separately from "no keys at all", so you can
tell which half is unfinished.

## 4. Send one test event

This is the step that has never happened. The signature check, the replay
guard and the account matching are covered by tests, but nothing has been
verified against Razorpay's real payload shape.

Razorpay dashboard → Webhooks → your webhook → Send test event
(`subscription.activated`). Then:

```sh
railway logs | grep razorpay
```

- `no matching user for ...` is the expected result for a test event: it has no
  `notes.user_id`, so there is nobody to match. The signature passed, which is
  what you are testing.
- A 401 means the secret does not match between the dashboard and Railway.

Then buy a plan yourself with a test key and confirm the subscription row
appears — Control Room → Users → your account → Billing.

## How an account gets matched to a payment

`POST /api/billing/checkout` puts `notes.user_id` on the subscription, taken
from the session — never from the request body. The webhook reads it back.

A subscription created **by hand in the Razorpay dashboard** has no notes, so
the webhook falls back to `notes.email`. If you create one by hand, add an
`email` note matching the account, or the payment cannot be matched to anyone.
