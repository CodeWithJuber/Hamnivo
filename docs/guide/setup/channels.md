# Channels: email, WhatsApp and Telegram

Answer email, WhatsApp and Telegram from the same inbox as your web chat. Conversations from
these channels show up in the **Inbox** next to your chats, follow your routing and automations,
and can be answered by the AI if you allow it.

## Add a channel

For now, add the channel in Chatwoot. Connecting channels from Studio is coming next.

1. In Chatwoot, open **Settings → Inboxes → Add inbox** and set up Email, WhatsApp or Telegram.
2. In Studio, open **Settings → Channels** and choose **Check for new channels**. Studio also
   checks by itself every few minutes.
3. The channel appears with its address, for example `help@yourshop.com`.

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

## Good to know

- One customer per address: the same email address or phone number is the same customer in every
  conversation. The address is what the customer wrote from, so Hamnivo shows it as not verified.
- Hamnivo never stores your mailbox password or channel tokens. They stay in Chatwoot.
- If a message reaches Chatwoot while Hamnivo is busy, Hamnivo still picks it up within a minute
  or two.
- AI memory stays off for customers who write by email, WhatsApp or Telegram, because they never
  agreed to it in the chat.
