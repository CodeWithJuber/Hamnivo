---
title: Team and roles
description: How to manage your team and permissions
---

Your team works together in Studio. Everyone logs in with email and two-step verification. What they see depends on their role.

## Invite someone

1. Go to **Settings** → **Team and access**
2. Click **Invite teammate**
3. Enter their email and choose a role
4. Click **Send invite**

They get an email with a link. They click it and create their account.

**What you'll see:** Their name in the team list, marked "Pending" until they accept.

## Roles and what they can do

Choose a role when you invite someone. Standard roles:

### Admin
- Answer chats
- Manage AI and knowledge
- Invite team and set roles
- See all reports
- Manage brands and Chatwoot connection
- Control settings

Use this for: The person running your Hamnivo account (usually you).

### Support agent
- Answer chats and take over from AI
- Use assigned chats
- See AI knowledge (what the agent knows)
- See which chats AI handled vs. people handled
- Cannot change settings or publish AI

Use this for: Everyone answering customers.

### Knowledge editor
- Upload and manage documents for AI
- Mark documents as ready or archived
- Cannot answer chats or see customer messages
- Cannot change settings

Use this for: Someone managing your FAQ or knowledge base, not answering chats.

### Supervisor
- Do everything a Support agent can do
- Create and publish AI agents
- See team performance and reports
- Cannot manage billing or invite people

Use this for: Your team lead answering chats and managing AI.

### Analyst
- See reports on which chats AI handled, which people handled
- See team performance (response time, resolution rate)
- Cannot answer chats, manage AI, or change settings

Use this for: Someone tracking your performance metrics.

## Create a custom role

Don't see the right fit? Create your own.

1. Go to **Settings** → **Team and access** and open the **Roles** tab.
2. Click **New role**.
3. Give it a name (for example "Sales agent") and tick what the role may do.
4. Save it.

**What you'll see:** your role in the list. You can now give it to people.

## Remove someone from your team

1. Go to **Settings** → **Team and access**, **Members** tab.
2. Open the person's menu and choose **Remove**, then confirm.

**What you'll see:** they lose access to this workspace at once. Their roles are removed and they
leave their teams. Their chats stay in the Inbox for someone else to take over.

## Change someone's role

1. Go to **Settings** → **Team and access**, **Members** tab.
2. Open the person's access and add a role, or press **Remove role** next to one.

The change applies on their next click in Studio.

## Two-step verification

Everyone on your team must turn on two-step verification to:
- Publish AI agents
- Sign in again after a long time away
- Publish other settings changes

This keeps your account safe. Set it up once: use an authenticator app (Google Authenticator, Authy, etc.) or a security key.

**Your team:**
1. Click the account menu → **Account security**
2. Choose "Authenticator app" or "Security key"
3. Follow the steps
4. Save recovery codes

## Single sign-on (SSO)

If your company uses Google Workspace, Microsoft 365, or another identity provider, you can set up SSO.

Go to **Settings** → **Security** and connect your provider. Your team logs in with their company account, no extra passwords.

## Session timeout

By default, if Studio sits idle for 2 hours, you're logged out for security. You can:
- Stay logged in on shared computers (if you trust them)
- Adjust the timeout in **Account security**

## What gets logged

Hamnivo keeps an audit log of:
- Who answered each chat
- When AI was stopped
- Who changed settings
- When people were invited or removed
- Changes to knowledge

You can view it in **Settings** → **Team and access** → **Audit log**, and download it with **Export** (as a spreadsheet file, or as NDJSON with hashes).

## Permissions details

Here's the full matrix of what each role can do:

| Action | Admin | Supervisor | Support Agent | Knowledge Editor | Analyst |
|--------|-------|-----------|-----------------|-----------------|---------|
| Answer chats | ✓ | ✓ | ✓ | | |
| Take over from AI | ✓ | ✓ | ✓ | | |
| Create AI agents | ✓ | ✓ | | | |
| Upload knowledge | ✓ | ✓ | | ✓ | |
| Manage documents | ✓ | ✓ | | ✓ | |
| See knowledge search | ✓ | ✓ | ✓ | ✓ | |
| See reports | ✓ | ✓ | ✓ | | ✓ |
| Invite people | ✓ | | | | |
| Change roles | ✓ | | | | |
| Manage brands | ✓ | | | | |
| Manage Chatwoot | ✓ | | | | |
| See settings | ✓ | | | | |
| See audit log | ✓ | | | | |

Your team members with "Support Agent" and above can see which customers are waiting and take over from AI anytime.
