---
title: Frequently asked questions
description: Short, honest answers to common questions about Hamnivo
---

## Do I need to open Chatwoot?

No. Chatwoot is the engine that stores conversations underneath Hamnivo. You and your team work in
Hamnivo Studio, including saved replies and tags (**Inbox** → **Saved replies and tags**).

## Who can see my conversations?

- **Self-hosted:** everything stays on your own server.
- **On a Hamnivo service run by someone else:** on that operator's server.
- **AI features:** when the AI answers, the conversation is sent to the AI company whose key you
  added. When the message guard or other checks are on, customer messages are also sent to
  TypeSafe (Jev), with personal details such as emails and phone numbers removed first.

## What does the AI cost?

You pay the AI company for what your key uses. Hamnivo's built-in practice model is free, but it
only gives sample answers. Your plan and your workspace's AI budget limit how many AI replies are
sent; when they run out, your team answers instead.

## Which AI companies can I use?

Anthropic, OpenAI, Google Gemini, and any service that works like OpenAI's (including models you
run yourself). Keys are stored encrypted, and **Test** checks a key before customers depend on it.
See [AI keys](/docs/setup/ai-keys/).

## Can I bring my old conversations?

Yes: **Settings** → **Import history**. It walks you through checking a sample before anything is
imported.

## Can I change how the chat looks?

Yes: your colour, logo, corners, greeting and offline message, with a live preview. Go to
**Settings** → **Brands and install** and press **Look and wording** on your brand.

## What happens if the AI can't answer?

The chat goes to your team with a note saying why, and the customer is told a person will reply.
This also happens if the AI company is down or the customer asks for a person. Nothing is lost.

## Can the chat speak my customers' language?

The chat comes in English, Arabic, Hindi and Urdu, including right-to-left layout. The AI replies
in the customer's language, including Hinglish and Roman Urdu.

## What if nobody is online?

Set your [business hours](/docs/setup/business-hours/). Outside them, customers see your offline
message and when you'll be back. Inside them, the chat says a person is available only when someone
who can answer is online.

## Will I notice new chats?

Yes: sounds, desktop notifications, and unread counts in the browser tab. See
[Sounds and notifications](/docs/inbox/sounds-and-notifications/).

## Is there a mobile app?

Not yet. Studio works in your phone's browser.

## How do I get help?

If you run Hamnivo yourself, start with [Self-hosting made simple](/docs/self-hosting/) and the
`hamnivo.sh doctor` command. Otherwise, ask the person or company that runs your Hamnivo.
