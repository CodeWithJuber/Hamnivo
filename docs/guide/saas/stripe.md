# Take payments with Stripe

With Stripe connected, a workspace owner buys a plan in Studio:

- **Upgrade** opens Stripe Checkout for the plan;
- **Manage billing** opens the Stripe Customer Portal (card, plan change, cancellation, invoices);
- Hamnivo follows Stripe: the workspace gets the plan it pays for.

Read [Run Hamnivo as a service](run-as-saas.md) first.

## 1. Create the prices in Stripe

1. In the Stripe dashboard, open **Product catalogue** and add a product for each plan you sell,
   for example "Pro".
2. Give it a **recurring** price, for example 49.00 USD a month.
3. Copy the price ID. It starts with `price_`.

## 2. Link each plan to its price

Add `stripePriceId` to the plan and set it again:

```json
{"key":"pro","name":"Pro","currency":"USD","priceMinor":"4900","trialDays":14,
 "stripePriceId":"price_1Q2w3E4r5T6y7U8i",
 "limits":{"conversations":2000,"aiReplies":10000,"seats":10,"webhookEndpoints":5}}
```

```bash
b=(./deploy/production/hamnivo.sh compose exec -T -e HAMNIVO_OPERATOR=you@example.com \
   api node dist/main.billing.js)
"${b[@]}" plan:set - < pro.json
```

Studio offers only plans with a Stripe price. Trials run in Hamnivo, not in Stripe: a workspace
that buys a plan during its trial pays from that day, and the trial ends.

## 3. Set up the Customer Portal

In Stripe, open **Settings → Billing → Customer portal** and turn on:

- updating payment methods;
- cancelling subscriptions;
- switching plans, with the products you sell (a change made there reaches Hamnivo by itself).

## 4. Add the webhook

1. In Stripe, open **Developers → Webhooks** and add an endpoint:

   ```text
   https://<your API address>/v1/integrations/billing/stripe
   ```

2. Choose these events:

   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `customer.subscription.paused`,
     `customer.subscription.resumed`
   - `invoice.paid`, `invoice.payment_failed`

3. Copy the signing secret. It starts with `whsec_`.

Hamnivo checks the signature of every event and applies each one once, in any order. A repeated
event changes nothing.

## 5. Turn it on

Add to `.env`, then run `./deploy/production/hamnivo.sh up`:

```bash
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
BILLING_GRACE_DAYS=7
```

You can use a restricted key (`rk_live_...`) instead of the secret key. It needs write access to
Customers, Checkout Sessions and the Customer portal, and read access to Invoices and Subscriptions.

Keep the keys out of chats, tickets and the repository. They live only in `.env`.

## 6. Try it in test mode first

1. Use test keys (`sk_test_...`) and a test webhook endpoint.
2. In Studio, open **Settings → Plan and billing** and choose **Upgrade** on a plan.
3. Pay with the test card `4242 4242 4242 4242`, any future date and any CVC.
4. Back in Studio, the plan changes within a few seconds, and the owners get a receipt email.

In development, the Stripe CLI forwards events to your machine:

```bash
stripe listen --forward-to localhost:4000/v1/integrations/billing/stripe
```

Put the `whsec_...` secret it prints in `STRIPE_WEBHOOK_SECRET`.

## What happens when a payment fails

1. Stripe reports the failed payment. The workspace keeps its plan for `BILLING_GRACE_DAYS` days,
   and its owners get an email with a link to pay.
2. Studio shows the date the grace period ends.
3. If the invoice is paid in time, nothing else happens.
4. If not, the workspace moves to the free plan when the grace period ends. Nothing is deleted.
   Paying later, or buying a plan again, brings the plan back.
5. When Stripe gives up and cancels the subscription, the workspace stays on the free plan and
   **Upgrade** is offered again.

## Good to know

- One Stripe customer per workspace. A second click on **Upgrade** opens a new page for the same
  customer, and a workspace with a live subscription changes its plan in the portal, so it can
  never pay twice.
- Workspaces that pay through Stripe get no invoice from Hamnivo's own invoicing.
- In the platform console, a workspace with a Stripe subscription cannot get another plan from
  you: change it in Stripe, or cancel the subscription first.
- Events about customers Hamnivo does not know are acknowledged and ignored.
