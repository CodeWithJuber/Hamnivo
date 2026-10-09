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

The customer can write again at any time, which opens a new 24-hour window.

## Template messages

After the 24 hours, you can still send a **template message**: a message you wrote in advance and
Meta approved, such as an order update.

1. Create the template in Meta's **WhatsApp Manager** (**Message templates**) and wait for Meta
   to approve it. Your chat engine fetches approved templates from Meta regularly; the picker
   shows when it last did.
2. In the conversation, choose **Send a template**. The button is also next to **Saved replies**
   while the window is open.
3. Pick the template, fill in every value it asks for (a name, an order number…), and check the
   preview. **Send** works once every value is filled in.

The customer reads exactly what the preview shows. If they answer, the 24-hour window opens again.

Some templates can't be sent from Hamnivo:

- templates Meta has not approved yet;
- one-time-code (authentication) templates, which your own systems send;
- templates with a photo, video or document at the top (for now).

They are listed but can't be chosen.

## Good to know

- Your access token goes to your chat engine (Chatwoot), which keeps it. Hamnivo stores none and
  never shows it again.
- Product and order cards arrive on WhatsApp as text with a link.
