# Visitor details

When a customer chats with you, Studio can show what their visit to your website looks like, so
you can help them in context: which page they are on, which pages they looked at, and a few facts
about their visit.

## Where to see it

1. Open **Inbox** and select a chat.
2. In the details beside the chat (on a phone, select **Details**), find **Website visit**.

You see:

- **On the website now**, or when the customer left.
- **Current page**: its title and address. Select it to open the page in a new tab.
- **Visits**: how many times the customer has come, and whether they are **New** or **Returning**.
- **Time on site**: how long this visit has lasted.
- **Country**, **Device** (phone, computer or tablet, with the browser and system) and **Language**.
- **Came from**: the website that sent them to yours, such as a search engine.
- **Pages in this visit**: the pages they opened, newest first, with the time.

## When nothing is shown

You may see "No pages are noted for this customer". The most common reasons:

- The customer's browser sends **Do Not Track** or **Global Privacy Control**. Hamnivo then notes
  nothing about them, on purpose.
- The chat was opened somewhere your website's chat script does not run, for example from a link
  in an email.
- Your brand has turned off page tracking (you see "This brand does not note which pages visitors
  view").

## What Hamnivo keeps, and what customers are told

- Customers see a line in the chat that says the website notes which pages they view, and that
  turning on **Do Not Track** in their browser stops it.
- Page addresses are kept **without** the part after a question mark (it can hold email addresses or
  order numbers), unless your brand chose to keep it. Even then, values that look like passwords or
  tokens are removed.
- **No IP address is stored.** The country comes from Cloudflare, when your server is behind
  Cloudflare. The device and browser come from the browser's own description of itself.
- The chat script keeps a random key in the visitor's browser, so a returning visit can be
  recognised. Hamnivo stores only a scrambled copy (a hash) of it, never the key itself.
- Pages and visits are deleted **30 days** after the visitor was last seen.
- You only see visitors of the brands your role covers.

## Turn tracking off for a brand

You need permission to configure the chat widget.

1. Open **Inbox**, then **Live visitors**.
2. Under **Visitor tracking**, choose the brand.
3. Turn off **Note which pages visitors view**, then select **Save**.

The change applies from each visitor's next page view. To keep or drop the part of a page address
after a question mark, use the other switch in the same place.

## For the person who manages the website

The usual install snippet from **Settings, Brands and install** already includes everything needed.
To stop the script from reporting pages on one page of your site (for example until a visitor
agrees to cookies), add `data-visitors="off"` to the script tag.
