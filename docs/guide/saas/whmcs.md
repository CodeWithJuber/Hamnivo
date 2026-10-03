# Sell workspaces with WHMCS

The Hamnivo module for WHMCS turns a WHMCS product into a Hamnivo workspace:

| In WHMCS | In Hamnivo |
|---|---|
| Create (an order is paid) | A new workspace on the product's plan. Its owner gets an invitation by email. |
| Suspend | The workspace becomes read-only, and its website chat shows offline. |
| Unsuspend | Everything works again. |
| Terminate | The workspace is closed for good. Its data stays until you delete it. |
| Change package (upgrade, downgrade) | The workspace moves to the new product's plan. |
| Resend owner invitation (a button) | The invitation is sent again, while nobody has accepted it. |

The module calls Hamnivo's operator API with a key you create. Read
[Run Hamnivo as a service](run-as-saas.md) first.

## 1. Create an operator API key

1. In Hamnivo's platform console, choose **Sign-up and billing**.
2. Under **Operator API keys**, name a key (for example "WHMCS") and choose **Create key**.
3. Copy the key. It starts with `hvop_` and is shown only once.

Hamnivo keeps only a hash of it. If it leaks, revoke it there and create another.

## 2. Install the module

Copy one file from this repository into your WHMCS installation:

```text
integrations/whmcs/modules/servers/hamnivo/hamnivo.php
  →  <WHMCS>/modules/servers/hamnivo/hamnivo.php
```

It needs PHP 7.4 or later with cURL, which WHMCS already requires. The `tests` folder is not
needed in WHMCS.

## 3. Add your Hamnivo server

1. In WHMCS, open **System Settings → Servers → Add New Server**.
2. **Module:** Hamnivo.
3. **Hostname:** your Hamnivo API address, for example `api.example.com`.
4. **Password:** the operator API key.
5. Tick **Secure** (HTTPS).
6. Choose **Test Connection**. It should succeed.

## 4. Create a product

1. Open **System Settings → Products/Services** and create a product.
2. Under **Module Settings**, choose the module **Hamnivo** and your server group.
3. Fill in:
   - **Plan key**: the Hamnivo plan it sells, for example `pro` (empty: the server's default plan);
   - **Start trial**: start with the plan's trial days;
   - **Language**: the workspace's default language;
   - **Create first brand**: a first brand named after the client, with the service domain as its
     website, and its chat set up right away.
4. Choose **Automatically setup the product as soon as the first payment is received**.

For upgrades and downgrades, create one product per plan and allow the clients to switch between
them.

## 5. Tell Hamnivo that WHMCS bills

Add to `.env`, then run `./deploy/production/hamnivo.sh up`:

```bash
BILLING_PROVIDER=whmcs
WHMCS_CLIENT_AREA_URL=https://billing.example.com/clientarea.php
HAMNIVO_PUBLIC_SIGNUP=false
```

- In Studio, **Manage** under **Settings → Plan and billing** opens your client area, where
  customers pay and change plans.
- With public sign-up closed, new customers come through WHMCS. The invited owner can still create
  an account with the invited address.

## What the customer receives

The owner gets an email from the workspace: "You have been invited to <name> on Hamnivo". They
create an account (or sign in) with that address and accept. The link is valid for 7 days; use
**Resend owner invitation** in WHMCS for a new one.

## Good to know

- Every call is safe to repeat. The workspace is found by the reference `whmcs:<service id>`, so a
  retried Create returns the same workspace and resends the invitation.
- Hamnivo's own invoicing skips workspaces billed by WHMCS.
- A terminated workspace cannot be unsuspended. Create a new service instead.

## When something goes wrong

- WHMCS shows Hamnivo's reason, for example "Hamnivo: Some fields need attention. (planKey: There
  is no active plan gold.)". Fix the product setting and run the action again.
- **Utilities → Logs → Module Log** lists every call. The key is masked.
- Hamnivo's platform audit log records each change, with the key's name.
