---
title: Running Hamnivo as SaaS
description: What changes when one Hamnivo server serves many businesses, and which guide covers each part
---

This page is for people who run one Hamnivo server for many businesses. Each business signs up in
Studio and gets its own workspace. You decide who may sign up, which plan they start on and how
they pay.

## What each business gets

- Its own **workspace**: people, brands (websites), chats, knowledge, AI settings and plan.
- Its data kept apart by the database itself. Every workspace table has row-level security, so
  one workspace cannot read another's. There is nothing for you to set up.

## What you decide

- **Who may sign up:** anyone (the default) or only invited people, with an optional Cloudflare
  Turnstile check against robots.
- **Plans:** new workspaces start on the **free** plan: 100 conversations, 200 AI replies and
  500,000 AI tokens a month, 25 MB of knowledge, 2 seats and 1 webhook endpoint. You can change
  it, add plans with their own limits and price, and offer a trial.
- **Payments:** none, Stripe (customers pay by card in Studio), or WHMCS (you sell workspaces from
  your billing system).
- **The platform console** (`/platform` in Studio): open a workspace to see its plan and usage,
  change its plan, or suspend and reactivate it. Every change is recorded in the audit logs.

## The guides

- [Run Hamnivo as a service](/docs/saas/run-as-saas/): sign-up, plans, trials, the platform
  console and emails.
- [Take payments with Stripe](/docs/saas/stripe/)
- [Sell workspaces with WHMCS](/docs/saas/whmcs/)
- [What a suspended customer sees](/docs/saas/suspended/)

## Your addresses

```
example.com          the public website, and these docs at /docs/
app.example.com      Studio: everyone signs in here; the platform console is at /platform
api.example.com      the API
chat.example.com     the chat on your customers' websites
support.example.com  Chatwoot, where the conversations are kept
```

`hamnivo.sh setup --domain example.com` gives these names. Change them in
`deploy/production/.env` if you want others.

## Growing

Everything runs on one server (see [Self-hosting](/docs/self-hosting/)). As customers join, watch
`hamnivo.sh doctor` and the usage in the platform console, and move to a bigger server when memory
or disk runs low.
