# Let the assistant look up orders (Shopify and WooCommerce)

Customers ask "where is my order?" more than anything else. Connect your Shopify or WooCommerce
store, and the assistant can answer that by itself, with the order's real status, delivery and
tracking.

It only **reads**. It never changes an order, refunds, cancels or sees a customer's address or
payment details.

## What the assistant can do

| It can | How it finds the order | Who can ask |
|---|---|---|
| **Read the customer's orders** | Recent orders placed with the email your website verified | A customer your website signed in, with a verified email |
| **Look up one order** | The order number and the email it was placed with, as a "track my order" page asks | Anyone in the chat |

What it can tell the customer about an order:

- its number and date;
- whether it is paid;
- whether it has shipped;
- the tracking company, number and link;
- how many items it has;
- its total.

If the email does not match the order, the assistant hears exactly what it would hear for an
order that does not exist. Guessing order numbers gets nobody anything.

## Connect Shopify

You need a Shopify staff account that may create apps.

1. In your Shopify admin, open **Settings**, then **Apps and sales channels**, then **Develop
   apps**. If Shopify asks, press **Allow custom app development**.
2. Press **Create an app**. Name it "Hamnivo".
3. Under **Configuration**, choose **Admin API integration**, then tick **read_orders**. Nothing
   else is needed. Press **Save**.
4. If Shopify offers **Protected customer data access**, allow the customer's **email**. Hamnivo
   uses it only to check that an order belongs to the person asking.
5. Press **Install app**, then **Reveal token once** under **Admin API access token**. Copy it. It
   starts with `shpat_`.
6. In Hamnivo Studio, open **Connectors** and choose your brand. Under **Shopify**, press
   **Connect Shopify**.
7. Fill in the form:
   - a name;
   - your shop's address that ends in `.myshopify.com`, such as
     `https://noor-books.myshopify.com`. Your own domain will not work here: Shopify's Admin API
     answers only on the `.myshopify.com` address;
   - the access token.
8. Leave both reads ticked, and press **Connect Shopify**.

Hamnivo tests the token straight away, then shows **Active** or what went wrong.

## Connect WooCommerce

You need a WordPress administrator account.

1. In WordPress, open **WooCommerce**, then **Settings**, then **Advanced**, then **REST API**.
2. Press **Add key**:
   - for **Description**, type "Hamnivo";
   - for **User**, choose an administrator or shop manager;
   - for **Permissions**, choose **Read**.
3. Press **Generate API key**. Copy the **Consumer key** (`ck_…`) and the **Consumer secret**
   (`cs_…`). WordPress shows them only once.
4. In Hamnivo Studio, open **Connectors** and choose your brand. Under **WooCommerce**, press
   **Connect WooCommerce**.
5. Fill in the form: a name, your website's `https://` address, the consumer key and the consumer
   secret.
6. Press **Connect WooCommerce**.

WooCommerce's REST API needs **Settings**, **Permalinks** set to anything but **Plain**. Most sites
already are.

## Then make the assistant use it

Both reads are created switched on.

- If your assistant is not live yet, press **Make the assistant live** on Home. It gives the
  assistant every read-only tool the brand has, these included.
- If it is already live, open **Agents**, open your assistant, add the two order tools under
  **Tools**, and publish.

## Signed-in customers

The first read, **Read the customer's orders**, needs a customer your website signed in, with an
email address the website confirmed:

- **WordPress with WooCommerce:** the Hamnivo Chat plugin signs customers in. Tick **This site
  confirms email addresses before people can sign in** in its settings, if it is true.
  [The steps](../integrations/wordpress.md).
- **Shopify:** the chat treats every visitor as anonymous unless a developer signs customers in
  ([how it works](../../guides/identity.md)). Without that, customers use the second read: the
  assistant asks for the order number and email.

## If it does not work

| What Studio says | What to do |
|---|---|
| Shopify refused the access token | Copy the token again (it starts with `shpat_`). Check the app has **read_orders** and is installed. |
| No Shopify shop answers at this address | Use the `.myshopify.com` address, not your own domain. |
| WooCommerce refused the key | Check the consumer key and secret, and that the key's permission is **Read** (or **Read/Write**). |
| WooCommerce does not answer at this address | Check that WooCommerce is active, and that **Permalinks** is not set to **Plain**. |
| … did not answer | The store was down or slow. Press **Test** again later. |
| Hamnivo may not reach this address | The address points to a private network, or your Hamnivo only allows certain hosts. Ask whoever runs your Hamnivo. |

To change a key, open the connection's **Reconnect**, paste the new one, and press **Reconnect**.
**Disable** stops the assistant using the store at once.

## What is checked, and what is not yet

- **Checked:** Hamnivo's side, against stand-ins for Shopify and WooCommerce that answer the way
  their APIs document. That covers connecting, a refused key, a store that is down, orders found by
  verified email, and an order found by number and email (a wrong email finds nothing).
- **Not yet:** a real Shopify store or WooCommerce site. If something looks wrong on yours, tell
  us what Studio shows.
