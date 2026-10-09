# Connect WhatsApp

Answer WhatsApp messages from the Hamnivo inbox, with your WhatsApp Business number on Meta's
Cloud API.

## Before you start

In Meta's **WhatsApp Manager** (Business Manager), you need:

- your business phone number, in international format (for example `+971501234567`);
- its **Phone number ID** and your **WhatsApp Business Account ID** (WhatsApp → API setup);
- a **permanent access token** from a system user with the `whatsapp_business_messaging` and
  `whatsapp_business_management` permissions. Temporary tokens stop working after a day.

## Connect

1. Open **Settings → Channels** and choose **Connect WhatsApp**.
2. Fill in the number, the two IDs and the access token. Hamnivo asks Meta to check them.
3. Choose whether the AI answers here (off at first) and which team gets these chats.
4. Choose **Connect**. Hamnivo then shows a **Callback URL** and a **Verify token**.
5. In Meta's App Dashboard, open **WhatsApp → Configuration → Webhook**. Paste both, choose
   **Verify and save**, then subscribe to **messages**.

You can see the callback URL and verify token again with **Meta set-up** on the channel's card.

## The 24-hour rule

WhatsApp lets a business reply freely for **24 hours** after the customer's last message. After
that, only approved template messages may be sent. Hamnivo follows this:

- the composer shows how long is left, and then that only templates are allowed;
- a reply after the window is refused, and nothing is sent;
- the AI and automations don't send messages after the window either.

The customer can write again at any time, which opens a new 24-hour window. Sending template
messages from Hamnivo comes later.

## Good to know

- Your access token goes to your chat engine (Chatwoot), which keeps it. Hamnivo stores none and
  never shows it again.
- Product and order cards arrive on WhatsApp as text with a link.
