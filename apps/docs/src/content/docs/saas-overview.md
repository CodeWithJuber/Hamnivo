---
title: Running Hamnivo as SaaS
description: Overview for operators running Hamnivo as a service for multiple businesses
---

This page is for people running Hamnivo as a SaaS platform — offering it to many customers.

## What is SaaS mode?

In SaaS, you host one Hamnivo instance. Many customers sign up, each with their own:
- Workspace (company)
- Brands (websites)
- Conversations
- Team

Everyone uses the same software, the same domain. You control who can sign up, billing, and support.

## For operators

If you're running Hamnivo for others, see the detailed guides:

- **[Setup and configuration](/docs/guide/saas/)** — How to prepare the server, set billing, and invite customers
- **[Managing workspaces](/docs/guide/saas/workspaces)** — Create accounts, reset passwords, see usage
- **[Billing and plans](/docs/guide/saas/billing)** — Set pricing, track usage, handle invoices
- **[Support and access](/docs/guide/saas/support)** — Help customers, access their workspace if needed
- **[Monitoring and updates](/docs/guide/saas/monitoring)** — Health checks, logs, deploying new versions

## Architecture

```
Your domain (example.com)
├── app.example.com → Studio (all customers log in here)
├── api.example.com → API (data and AI)
├── chat.example.com → Chat widget (customers' websites)
├── support.example.com → Chatwoot (conversations stored here)
└── example.com → Public website (sign-up page)
```

Each customer gets a **workspace**. Conversations stay isolated by workspace. The database is shared but row-level security ensures customers only see their own data.

## Isolating customers

**Row-level security** (RLS) in PostgreSQL ensures that:
- Customer A cannot see Customer B's conversations
- Customer A cannot read Customer B's knowledge
- One customer's AI settings don't affect another's

This is built in. You don't configure it — it just works.

## Billing options

You can use:
- **Per-user pricing**: Charge by number of team members
- **Per-conversation pricing**: Charge by volume of chats
- **Per-feature pricing**: Charge by features they use (AI, reports, etc.)
- **Flat plan pricing**: Starter, Professional, Enterprise tiers

Hamnivo supports all of these. Set it up in the Platform console.

## Data residency

Customers care about where their data lives:
- **EU**: Run on a European server; their GDPR obligations are met
- **US**: Run on a US server
- **Private**: Some customers want to run their own Hamnivo instance (see [Self-hosting](/docs/self-hosting))

Plan your hosting region accordingly.

## Scaling

One Hamnivo instance can handle:
- Hundreds of workspaces
- Thousands of concurrent chats
- Millions of conversation history

Scale by:
1. Adding memory to the server (more PostgreSQL connections)
2. Adding CPU (more API workers)
3. Load-balancing across multiple servers (advanced)

Start on one server and watch `hamnivo.sh doctor` and your usage as customers join; move to a bigger server when memory or disk runs low.

## Next steps

- Set up the Platform console (`app.example.com/platform`)
- Invite your first customer
- Monitor usage in the dashboard
- See the SaaS guides for detailed workflows

Questions? See the detailed SaaS documentation in `/docs/guide/saas/`.
