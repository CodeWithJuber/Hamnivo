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
address. An administrator may open Chatwoot for the few things Studio does not do yet: defining
tags and custom fields, and editing or deleting saved replies.

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
| **Settings** | Brands and install, Team and access, Security, Developer, Import history |

Two things are not in the menu:

- **Stop AI** is a red button in the header, on every page, for people who can stop the AI
  (permission to publish agents). It opens the Stop AI page.
- **Account security** and the **Platform console** (operators only) are in the account area at
  the bottom of the menu, which is a sheet on a phone.

## What each role sees

A page's permission has not changed: the menu only groups the pages. A **✓** below means the
entry is there, and a list names the pages you can open in it.

| Role | Home | Inbox | AI assistant | Sales | Reports | Settings |
|---|---|---|---|---|---|---|
| Owner | ✓ | ✓ | all nine pages | both pages | ✓ | all six pages |
| Administrator | ✓ | ✓ | all nine pages | both pages | ✓ | all six pages (Plan and billing shows only the email sender name) |
| Supervisor | ✓ | ✓ | all but Model connections | both pages | ✓ | Team and access |
| Support agent | ✓ | ✓ | Knowledge, Tools and permissions, Answer caching | both pages | | Team and access (read only) |
| Finance | ✓ | | Activity | both pages | ✓ | Team and access |
| Knowledge editor | ✓ | ✓ | AI agents, Knowledge, Answer caching | | | |
| Developer | ✓ | | AI agents, Model connections | | | Team and access, Developer |
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
- If you can do any setup step, it shows **Get set up**, with the steps that are still open: connect the chat
  engine, add a brand and install the chat, publish an AI agent, invite a teammate. Each step links
  to its page, and a step shows only if you can do it. The list disappears when every step is done.
  Studio cannot tell whether the install code is on your website, so "install the chat" counts as
  done once a brand has a website allowed to load it. When no open step is one you can do, this
  block shows nothing.

Below that, Home is the same for everyone: your brands with their chat connection and AI status,
the AI stop switches, and the latest runs.
