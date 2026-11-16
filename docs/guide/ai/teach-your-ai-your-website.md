# Teach your AI your website

Hamnivo can read the pages of your website and keep them up to date. Your AI then answers
customers from what your pages say, and its answers name the page they came from. You add the
address once. Hamnivo reads it again on the schedule you choose.

A website is a knowledge source like any other. Its pages are the source's documents, so you can
see them, review them, retire them and search them in **Knowledge**.

**Your brand's own website is added for you.** When a brand gets its first `https://` website on
its allowed list, Hamnivo adds that website here and starts reading it, with the settings below
(the whole site, 50 pages, every week, public answers). It is not added again, and test addresses
(`localhost`, IP addresses, `.example`, `.test`) are never read. **Make the assistant live** (on
Home or under AI agents) then gives the brand's assistant all of its knowledge. A website you add
later is used once you press it again, or tick it in the agent's editor and publish.

## What you need

- The **Owner**, **Administrator** or **Knowledge editor** role (the permission
  `knowledge.manage`).
- A website that anyone can open on the internet, at an address that starts with `https://`.
  Hamnivo cannot read pages behind a sign-in or on a private network.
- A website you are allowed to read. Hamnivo follows the site's own rules (see below), but the
  decision to add a website is yours.

## Add a website

1. Open **Knowledge** and choose **Add website**.
2. Choose the **Brand** whose AI should know these pages.
3. Type the **Website address**: the page to start from, such as `https://example.com/help/`.
   Only pages in that folder are read.
4. Under **What to read**, choose **The whole site** or **Just this page**.
5. For the whole site, set **Most pages to read** (1 to 500, 50 to start with) and **How many
   links to follow** (0 to 5, 2 to start with). Links are counted from the first page.
6. Choose how often to **Read again**: every day, every week, or only when you ask.
7. Choose who can get answers from it: **Public answers**, or **Team only** for your team's own
   searches. AI replies and [AI drafts](../inbox/ai-drafts.md) use public sources only.
8. Choose **Add website**.

Hamnivo starts within a few seconds. The first read can take a few minutes, and you can leave the
page. The website appears in the list of sources, and its panel shows how the read is going.

## What Hamnivo reads, and what it leaves out

Hamnivo reads like a polite visitor:

- It asks the site's **robots.txt** first and follows it. It answers to `HamnivoBot`, and to the
  general rules for all readers when there are no rules for it. If the file cannot be read
  because the site is down or answers with an error, nothing is read, as the robots.txt standard
  says. If the site has no robots.txt at all, every page is allowed.
- It reads the **sitemap** (`/sitemap.xml`, or the sitemaps robots.txt names) and follows the
  links between pages, down to the number of links you set.
- It stays on **one site** and inside the **folder** of the address you gave. From
  `https://example.com/help/` it reads `/help/returns` but not `/about`. Links to other sites are
  not followed. A page that sends visitors to another site is left out.
- It makes **one request at a time**, at least a second apart, and longer when the site asks
  (`Crawl-delay`) or says it is busy. Every request says it comes from `HamnivoBot`.
- It leaves out pages that ask not to be indexed (`noindex`), pictures, scripts, archives and
  other files that are not pages, and copies of a page it already read.
- It reads **PDF files** as documents, and pages written in other character sets, such as
  Arabic in Windows-1256, as ordinary text.
- It skips menus and footers, so the AI learns the text of the page.

Every page goes through the same steps as a file you upload: a malware scan, text extraction and
indexing. The version that was answering keeps answering until the new one is ready.

A page that builds its text with JavaScript shows no text to a reader that does not run it. Hamnivo
leaves it out and says so. Add its text as a document instead.

## Keep it up to date

Under **Read again**, choose every day, every week, or only when you ask. You can also choose
**Read now** at any time.

What a new read changes:

| What Hamnivo finds | What happens |
|---|---|
| A page it has not seen | A new document, indexed before it answers |
| A page whose text changed | A new version of the same document |
| A page that did not change | Nothing. Pages that can say "not modified" are not even downloaded |
| A page that is gone (404 or 410) | The document is retired |
| A page that now asks not to be indexed, or that robots.txt now keeps readers out of | The document is retired |
| A page nothing links to any more | The document is retired, after a complete read with no problems |
| A page that failed this time | Left as it was. A site that is down for a moment loses nothing |

A document you retired by hand stays retired. If you lower the **Most pages to read**, the pages
past the new limit are retired. A page that comes back, with the same text, answers again
without being indexed again.

## See how the last read went

The panel above the documents shows the address, what it reads, how often, when it was last read
and when it is read next. Under **What the last read did** you see:

- How many pages are new, changed, unchanged and removed.
- What was left out, and why: robots.txt, another site, noindex, not a page, copies, no text.
- The pages that could not be read, with a short reason for each (the first ten).
- Whether the read stopped early because of the page limit or the time.
- What the site's robots.txt said.

Choose **See pages** to list every page and what the last read made of it.

## Change a website, or stop reading it

- **Settings** changes what the website reads, its limits and its schedule. The address and who
  can get answers from it cannot change. Add a new website for a different address.
- To stop reading, open the source's settings in **Knowledge** and set it to **Paused**. A paused
  website is not read, and its pages stop answering. Set it back to **Active** to resume.
  **Retired** stops it for good.

## If something does not work

| What you see | What to do |
|---|---|
| The address sends visitors to `www.example.com`. Add that address instead. | The site moves every address to another one. Add the address it moves to. |
| The site's robots.txt could not be read, so nothing was read. | The site answered with an error, or did not answer. Try again later. |
| The site's robots.txt asks readers to stay away from this address. | The site owner asked readers to stay out of those pages. Hamnivo respects that. |
| This address points to a private or local network. | Hamnivo reads public websites only. Ask your server administrator (see below). |
| Use an https:// address. | Hamnivo reads sites over a secure connection only. |
| No readable text was found on the page. | The page needs JavaScript to show its text. Add the text as a document. |
| The page is too large. | Pages over 2 MB and PDF files over 5 MB are left out. |

## For server administrators

- Reading happens in the **worker** process, on its own loop beside the outbox, so a slow site
  never holds up replies or indexing. Run the worker for websites to be read.
- `KNOWLEDGE_WEB_DELAY_MS` (default `1000`) is the shortest pause between two requests to a site.
- Every request goes through the same egress guard as webhooks: public addresses only, `https`,
  and the workspace's **Allowed hosts** list when it has one. To let Hamnivo read a site on your
  own network, add its origin to `EGRESS_TRUSTED_ORIGINS`. Tenants cannot add one.
- The audit log records each change (`knowledge.web_source_added`, `knowledge.web_source_updated`,
  `knowledge.web_sync_requested`) and each read (`knowledge.web_synced`, with counts only). It
  never holds page text.
