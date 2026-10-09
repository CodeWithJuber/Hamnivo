# Channels: email, WhatsApp and Telegram

Answer email, WhatsApp and Telegram from the same inbox as your web chat. Conversations from
these channels show up in the **Inbox** next to your chats, follow your routing and automations,
and can be answered by the AI if you allow it.

## Add a channel

Open **Settings → Channels**, then:

- **Connect email**: see [Connect your support email](email-channel.md).
- **Connect WhatsApp**: see [Connect WhatsApp](whatsapp.md).
- **Connect Telegram**: see [Connect Telegram](telegram.md).

A channel added in Chatwoot itself (**Settings → Inboxes**) appears too: choose **Check for new
channels**, or wait a few minutes.

## Who answers

Each channel has an **AI answers here** switch, and it starts **off**:

- **Off:** your team answers every conversation on this channel.
- **On:** the AI answers first, and hands the conversation to your team when it needs a person.

The AI still follows your agent's settings. If no agent is published, or the AI is stopped,
your team answers.

## More settings on each channel

- **Team:** the team that gets new conversations from this channel. Leave it empty to use
  your routing rules.
- **Pause:** new conversations stay in Chatwoot until you resume. Conversations already in
  Hamnivo carry on.

## When a channel stops working

If Hamnivo cannot reach a channel, for example because a mailbox password changed or a token
expired, the channel shows **Needs attention** on **Settings → Channels**.

If it is still not working 15 minutes later:

- everyone who manages integrations for that brand gets an email, and
- Studio shows them a banner with a **Fix it** link.

When the channel works again, they get one more email, and the banner goes away. A problem that
fixes itself within 15 minutes tells nobody.

## Good to know

- One customer per address: the same email address or phone number is the same customer in every
  conversation. The address is what the customer wrote from, so Hamnivo shows it as not verified.
- Hamnivo never stores your mailbox password or channel tokens. They stay in Chatwoot.
- If a message reaches Chatwoot while Hamnivo is busy, Hamnivo still picks it up within a minute
  or two.
- AI memory stays off for customers who write by email, WhatsApp or Telegram, because they never
  agreed to it in the chat.
