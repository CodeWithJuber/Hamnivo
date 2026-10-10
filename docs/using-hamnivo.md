# Which app do I use?

Your team works in one place: **Hamnivo Studio**. Admins and staff use the same dashboard. What
each person sees in it depends on their role.

Chatwoot is the engine underneath. Nobody has to open it day to day.

## Who uses what

| App | Who uses it | How often | What it is for |
|---|---|---|---|
| **Hamnivo Studio** (`app.<your domain>`) | Everyone on your team, admins and staff | Daily | Answering customers in the inbox, the AI assistant, orders, reports and settings. |
| **Chatwoot** (`support.<your domain>`) | Nobody needs it day to day. It is the engine underneath Studio | Not needed daily | Keeps the conversations for Studio. An admin connects it once for each brand, from Studio. |
| **Platform console** (`app.<your domain>/platform`) | Only the server operator, the person who runs your Hamnivo server | Rarely | Server health, support access requests and incident notices. It is in the account menu, and only for people named as operators on the server. |
| **Chat widget and website** | Your customers | Whenever they need help | The chat on your website. Customers never see Studio or Chatwoot. |

You and your team work in Studio. Studio has no link to Chatwoot, and staff never need its
address. An administrator may open Chatwoot for the one thing Studio does not do yet: defining
custom fields. Saved replies and tags are set up in Studio, from the inbox (see
[Saved replies and tags](guide/inbox/saved-replies.md)).

## The menu in Studio

The menu has six entries. An entry appears only when you can open at least one page in it, and it
opens the first page you can open. When you can open two or more pages of an entry, they are shown
as a row of links above the page, so each one is a click away.

| Entry | Pages, in the order of the row |
|---|---|
| **Home** | Home: your chats or your setup steps, then your brands, AI stops and the latest runs |
| **Inbox** | The inbox |
| **AI assistant** | AI agents, Knowledge, Customer memory, Tools and permissions, Safety checks, Decision rules, Activity, Answer caching, Model connections |
| **Sales** | Orders, Finance exceptions |
| **Reports** | Reports |
| **Settings** | Brands and install, Chat widget, Channels, Automations, Business hours, Team and access, Support teams, Security, Developer, Customer sign-in, Import history |

### Find any page with Search

To jump straight to a page, press **⌘K** on a Mac or **Ctrl+K** on Windows and Linux, from
anywhere in Studio, or choose **Search** at the top of the screen. Type part of a page's name,
such as "billing" or "team", then use the arrow keys to choose and **Enter** to open it. **Esc**
closes the search.

- It lists only the pages you can open, grouped like the menu, and marks the page you are on.
- Typing a group's name, such as "Settings", lists every page in that group.
- English page names work in every language, so "billing" finds Plan and billing in Arabic,
  Hindi or Urdu too.
- It also finds the pages that are not in the menu (below), when you can open them.

Some pages are not in the menu:

- **Stop AI** is a red button in the header, on every page, for people who can stop the AI
  (permission to publish agents). It opens the Stop AI page. On a phone it shows only its red
  stop icon, so the header stays one row.
- **Account security** and the **Platform console** (operators only) are in the account area at
  the bottom of the menu, which is a sheet on a phone. On a phone, the language is chosen in that
  sheet too, above the account area; on wider screens it is at the top of the page.
- [**Live visitors**](guide/inbox/live-visitors.md) (everyone who can read chats) and
  [**Saved replies and tags**](guide/inbox/saved-replies.md) (people who manage the inbox) are
  buttons above the list of chats in the inbox. A row of links for them would push the inbox down.

## What each role sees

A page's permission has not changed: the menu only groups the pages. A **✓** below means the
entry is there, and a list names the pages you can open in it.

| Role | Home | Inbox | AI assistant | Sales | Reports | Settings |
|---|---|---|---|---|---|---|
| Owner | ✓ | ✓ | all nine pages | both pages | ✓ | all twelve pages |
| Administrator | ✓ | ✓ | all nine pages | both pages | ✓ | all twelve pages (Plan and billing shows only the email sender name) |
| Supervisor | ✓ | ✓ | all but Model connections | both pages | ✓ | Automations (read only), Team and access, Support teams |
| Support agent | ✓ | ✓ | Knowledge, Tools and permissions, Answer caching | both pages | | Team and access, Support teams (both read only) |
| Finance | ✓ | | Activity | both pages | ✓ | Team and access, Support teams |
| Knowledge editor | ✓ | ✓ | AI agents, Knowledge, Answer caching | | | |
| Developer | ✓ | | AI agents, Model connections | | | Chat widget, Channels, Team and access, Support teams, Developer |
| Analyst | ✓ | ✓ | Safety checks, Decision rules, Activity | | ✓ | |
| Billing manager | ✓ | | Activity | | ✓ | Plan and billing |

A custom role works the same way: the entry is there when one of its pages is allowed, and the row
lists only the allowed pages. The gateway checks every request again, so typing the address of a
page you may not open shows a notice, never its data.

## The top of Home

Home starts with a block that depends on what you do:

- If you do not manage brands (support agents and supervisors, for example), it shows **Your
  chats**: how many customers are waiting for a person and how many chats are assigned to you,
  with an **Open inbox** button.
- If you can do any setup step, it shows **Get set up**, with the steps that are still open, in
  the order to do them: add a brand and its website, put the chat on that website, connect the
  chat engine for it, add an AI key, publish an AI agent, invite a teammate. Each step links to its page, and a step shows only
  if you can do it. The list disappears when every step is done. A button on it, **Open guided
  setup**, opens the step-by-step guide at `/onboarding` (see the
  [setup guide](guide/setup/getting-started.md)). Two steps look further than a list can:
  - "Add an AI key" is done when the workspace has a key of its own that is on, or when the server
    holds a key for any provider.
  - "Publish an AI agent" counts only an agent that answers with a real model. An agent that
    answers with the offline practice model (the default until you choose a model) does not count,
    because customers would only get canned replies.

  - "Add your brand and website" is done once a brand has a website allowed to load the chat.
    "Put the chat on your website" is done once a page of that website has loaded the chat:
    Hamnivo notices that by itself, from the chat's code running there. It opens the guided setup
    at its install step, which turns green as soon as that happens.

  When no open step is one you can do, this block shows nothing.

Below that, Home is the same for everyone: your brands with their chat connection and AI status
(and, for people who manage brands, when the chat was last seen on the brand's website),
the AI stop switches, and the latest runs.

Each part of Home loads on its own. If one cannot load, it says why and has its own **Try again**;
the rest of Home stays as it is, and a note at the top says the rest of Studio, your inbox
included, still works, with an **Open inbox** button. If a part could not be refreshed, it keeps
what it showed and says when that was loaded.

## Setting up without help

A business owner can set Hamnivo up from Studio alone. The guides for it are in
[`docs/guide/setup`](guide/setup/getting-started.md):

- [Getting started](guide/setup/getting-started.md): the guided setup, step by step.
- [AI keys](guide/setup/ai-keys.md): add, test and replace the key your AI agents use.
- [How the chat looks](guide/setup/widget-look.md): colour, logo, corners and words.
- [Test chat](guide/setup/test-chat.md): try the real chat before any customer sees it.
- [Business hours](guide/setup/business-hours.md): when your team answers, and the days you are closed.
