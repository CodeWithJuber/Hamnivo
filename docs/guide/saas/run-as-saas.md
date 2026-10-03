# Run Hamnivo as a service

One Hamnivo server can host many businesses. Each business gets its own workspace, with its own
people, brands, chats and plan. This guide covers what you, the owner of the server, set up:

1. who may sign up;
2. the plans, and the plan new workspaces start on;
3. trials;
4. the platform console, where you watch and change workspaces;
5. emails and the automatic chat set-up.

Taking payments is in two more guides: [Stripe](stripe.md) (customers pay by card in Studio) and
[WHMCS](whmcs.md) (you sell workspaces from your WHMCS billing system). [What a suspended customer
sees](suspended.md) explains suspension.

Settings go in `deploy/production/.env` (or `.env.local` in development). Run
`./deploy/production/hamnivo.sh up` after changing them.

## Before you start: make yourself a platform admin

The platform console is at `https://<your Studio address>/platform`. Only platform operators can
open it. Sign up in Studio first, then name yourself:

```bash
./deploy/production/hamnivo.sh compose run --rm --no-deps migrate \
  node dist/main.operator.js you@example.com platform_admin
```

Turn on two-step verification under **Account security**. The console lets you look without it,
but every change needs it, and a sign-in from the last 10 minutes.

## 1. Who may sign up

| Setting | What it does |
|---|---|
| `HAMNIVO_PUBLIC_SIGNUP=true` | Anyone can create an account and a workspace (the default). |
| `HAMNIVO_PUBLIC_SIGNUP=false` | Only invited people can create an account. |

You can also switch it in the console without a restart:

1. Open the platform console and choose **Sign-up and billing**.
2. Under **Public sign-up**, choose **Close sign-up** or **Open sign-up**.
3. **Use the server setting** goes back to what `HAMNIVO_PUBLIC_SIGNUP` says.

While sign-up is closed:

- an address with a pending invitation can still create an account and join;
- platform operators can still create workspaces;
- on a brand-new server, the first account and the first workspace are always allowed, so you can
  set yourself up.

The change is recorded in the platform audit log.

### Stop robots with Cloudflare Turnstile

1. In the Cloudflare dashboard, open **Turnstile** and add a widget for your Studio address.
2. Copy the site key and the secret key into `.env`:

   ```bash
   TURNSTILE_SITE_KEY=0x4AAAAAAA...
   TURNSTILE_SECRET_KEY=0x4AAAAAAA...
   ```

3. Run `./deploy/production/hamnivo.sh up`.

The sign-up page now shows the check, and Hamnivo refuses a sign-up without a valid token. Set both
keys or neither. Studio's security policy allows Cloudflare's script only while the site key is set.

## 2. Plans

Every new workspace gets a plan: a copy of its limits (conversations, AI replies, AI tokens,
knowledge storage, seats, webhook endpoints).

- Hamnivo comes with a **free** plan: 100 conversations, 200 AI replies and 500,000 AI tokens a
  month, 25 MB of knowledge, 2 seats and 1 webhook endpoint. Change it with `plan:set` and the key
  `free`.
- `HAMNIVO_DEFAULT_PLAN` names the plan new workspaces start on. It is `free` unless you change it.
- `HAMNIVO_DEFAULT_PLAN=unlimited` gives new workspaces no plan, so nothing is limited. Use it when
  you host Hamnivo only for yourself.

Plans are JSON files, set with the billing command (see "Plans and invoices" in
[docs/self-hosting.md](../../self-hosting.md)):

```json
{"key":"pro","name":"Pro","currency":"USD","priceMinor":"4900","trialDays":14,
 "limits":{"conversations":2000,"aiReplies":10000,"seats":10,"webhookEndpoints":5}}
```

```bash
b=(./deploy/production/hamnivo.sh compose exec -T -e HAMNIVO_OPERATOR=you@example.com \
   api node dist/main.billing.js)
"${b[@]}" plan:set - < pro.json
"${b[@]}" plans
```

To change one workspace's plan, use the console (open the workspace under **Tenants**, then
**Change plan**) or `"${b[@]}" plan:assign <workspace> pro`. Workspaces that pay through Stripe
change their plan in Stripe.

## 3. Trials

A plan with `trialDays` can be tried first. When the trial ends, the workspace moves to the free
plan by itself, unless it bought a plan in the meantime.

- **Every new workspace on a trial:** give the plan trial days and make it the default, for
  example `HAMNIVO_DEFAULT_PLAN=pro` with `"trialDays":14` in `pro.json`.
- **One workspace:** in the console choose **Change plan**, the plan, and **Start the plan's
  trial**; or run `"${b[@]}" plan:assign <workspace> pro --trial`.

Studio shows the trial's end date under **Settings → Plan and billing**. A trial is never invoiced.

## 4. The platform console

Under **Tenants**, open a workspace to see its plan, trial, billing provider and usage this
period. A platform admin can:

- **Change plan** (with or without the plan's trial);
- **Suspend** and **Reactivate**, with a reason. A suspended workspace is read-only and its
  website chat shows offline: see [What a suspended customer sees](suspended.md).

Every change is recorded in the workspace's own audit log and in the platform audit log.

**Sign-up and billing** shows the sign-up switch, whether Turnstile is on, the default plan, all
plans, and the operator API keys that billing systems use ([WHMCS](whmcs.md)).

## 5. Emails and the automatic chat set-up

Hamnivo sends its emails as HTML with a plain-text version: welcome, invitation, email
confirmation, password reset, failed payment and receipt. Set `SMTP_URL` and `MAIL_FROM` (see
[docs/self-hosting.md](../../self-hosting.md)).

Each workspace chooses the name its emails come from under **Settings → Plan and billing → Email
sender name** (people who can edit workspace settings). The address stays the one in `MAIL_FROM`.

A workspace's first brand gets its Chatwoot account by itself, about 20 seconds after it is
created. **Brands and install** shows the progress. If a step fails, it says why; **Connect
Chatwoot** tries again and continues where it stopped, without creating a second account. Set
`CHATWOOT_AUTO_PROVISION=false` to connect every brand by hand instead.

## Settings at a glance

| Setting | Default | Meaning |
|---|---|---|
| `HAMNIVO_PUBLIC_SIGNUP` | `true` | Anyone may sign up (the console can override it). |
| `HAMNIVO_DEFAULT_PLAN` | `free` | Plan of new workspaces; `unlimited`: none. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | empty | Cloudflare Turnstile on sign-up. |
| `BILLING_PROVIDER` | `free` | `stripe` or `whmcs` to take payments. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | empty | [Stripe](stripe.md). |
| `BILLING_GRACE_DAYS` | `7` | Days a plan stays after a failed payment. |
| `WHMCS_CLIENT_AREA_URL` | empty | Where **Manage** sends [WHMCS](whmcs.md) customers. |
| `CHATWOOT_AUTO_PROVISION` | `true` | Set up a workspace's first brand by itself. |
