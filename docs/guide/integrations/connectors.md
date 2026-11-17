# Connect business systems and specialist agents

The **Connectors** page brings a brand's native business-system connections, external specialist
agents, MCP services, and reviewed tools into one place. Each client workspace has its own
connections and credentials. An agency directory link does not grant access to them.

People with **Tools: read** can see native connections. Creating, testing, reconnecting, disabling,
or changing their allowed actions requires **Tools: manage** and may ask for a recent sign-in.
External agent connections use the Automations permissions instead.

## Connect WHMCS

The native WHMCS connector lets an agent work with the signed-in customer's own WHMCS account. It
does not provision Hamnivo workspaces; see [Sell workspaces with WHMCS](../saas/whmcs.md) for that
separate server module.

Before connecting it, you need:

- the public HTTPS root address of WHMCS, such as `https://billing.example.com/`;
- a WHMCS API identifier and secret with only the permissions you plan to allow;
- an active customer identity key for the same Hamnivo brand; and
- the Hamnivo WHMCS addon configured to sign in customers with that key. Follow
  [Hamnivo Chat on WHMCS](whmcs.md#signed-in-clients-optional).

In Studio:

1. Open **Connectors** and choose the brand.
2. Under **WHMCS**, choose **Create**.
3. Enter a name, the WHMCS HTTPS root address, API identifier, API secret, and identity key ID.
4. Select the actions the connection may offer, then create it.
5. Read the connection test result. A successful test makes the connection active. A failed test
   leaves it visible but disabled, without showing the WHMCS response or credentials.
6. Open **Permission preview**, enter a disposable WHMCS user ID and client ID, and choose **Check
   permissions**. Review each configured action and the exact WHMCS permission it requires. An
   unverified or denied result grants nothing; update the WHMCS API role before continuing.

Hamnivo stores the identifier and secret in its encrypted secret store. They are not shown again.
Use **Reconnect** to replace both values, then test the connection again. **Disable** prevents new
uses of its generated tools. Under **Allowed actions**, you can replace the reviewed action list;
if another administrator changed it first, reload the page before saving again.

## Choose WHMCS actions

The connection offers this fixed catalog. An agent cannot supply another WHMCS API command.

| Action | What it does | Approval boundary |
|---|---|---|
| Read invoices, services, domains, or tickets | Reads the verified client's own records | Read only |
| Get an invoice payment link | Returns the official page for an owned invoice | Customer confirmation |
| Create or reply to a ticket | Writes to the verified client's ticket account | Customer confirmation |
| Quote an upgrade | Calculates a current quote without placing it | Read only |
| Request an upgrade | Rechecks a saved live quote before placing it | Staff approval |
| Request cancellation | Submits a cancellation request; WHMCS decides when service ends | Staff approval |
| Prepare refund handoff | Reads the owned invoice and prepares a staff review packet | Staff review; no refund API call |

The customer's verified identity contains both their WHMCS user ID and selected client ID. Hamnivo
checks that identity, the API role's explicit permission, and ownership of every returned record.
Knowing an invoice, service, domain, or ticket number is not proof of ownership.

Permission preview is a live read for the IDs you enter. It does not impersonate the customer or
perform any configured action. Hamnivo records the check and its allowed capability names in the
audit log without storing or displaying the API credential.

A refund handoff never calls a WHMCS refund command. An authorized person must review it and perform
any refund through the approved finance process. Likewise, upgrade and cancellation requests keep
their staff approval boundary even when the customer asked for them.

If a network or response failure happens after a write may have reached WHMCS, Hamnivo records an
unknown outcome and does not send a matching request again. Staff must check WHMCS and reconcile
the operation. This avoids creating a second ticket, upgrade, or cancellation after a lost answer.

## Connect Shopify or WooCommerce

A store connection lets the assistant read orders, and nothing else: a signed-in customer's recent
orders by the email your website verified, or one order by its number and the email it was placed
with. Under **Shopify** or **WooCommerce**, choose **Connect Shopify** or **Connect WooCommerce**.
Where to get each key, and what the assistant can tell customers:
[Let the assistant look up orders](../ai/connect-your-store.md).

## Connect an external specialist agent

Hamnivo supports private A2A 1.0 HTTP+JSON specialists. On **Connectors**, under **External
agents**:

1. Choose the brand and **Create**.
2. Enter a name and the specialist's HTTPS endpoint.
3. If it uses a bearer credential, enter the ID of an existing encrypted secret.
4. Create the connection, then add it to a workflow's **Delegate** step.

Creating or changing an A2A connection requires **Automations: manage**. Attaching a credential
also requires **Secrets: manage**. You can disable the connection without deleting workflow
history.

A delegation sends only the request written for that step. It sends no conversation transcript,
customer identifier, local permissions, tool credentials, or ability to delegate again. The
specialist's result is marked untrusted. A malformed, rejected, authentication-required, or timed
out result fails visibly, and a delegation whose outcome became unknown after a crash is never
sent again automatically.

## MCP services and tool permissions

The same page links to the existing MCP service and tool-permission screens. Use
[Connect MCP services](../ai/connect-mcp-services.md) for remote MCP setup. A connector being
active does not by itself give every agent its tools: review the generated tools and grant them to
the intended agents under **Tools and permissions**.

## Before using a WHMCS connection with customers

The repository tests the capability allowlist, ownership checks, approval boundaries, guarded
network requests, unknown write outcomes, addon packaging, and supported PHP behavior. A real
WHMCS account can differ in its API role and response shape. Before release, use a WHMCS
development licence or disposable test account to verify the exact API identifier permissions,
permission-preview results, signed-in client identity, and every action you plan to enable. Do not
test upgrades, cancellations, or refunds against a live customer's service.
