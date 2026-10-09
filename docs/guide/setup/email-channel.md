# Connect your support email

Answer your support email from the Hamnivo inbox. Hamnivo reads your mailbox and sends your
replies from the same address, so customers keep writing to the address they know.

## Before you start

You need your mailbox's settings: the incoming server (IMAP) and the outgoing server (SMTP). Most
providers also ask for an **app password**: a separate password just for email apps. Make one in
your provider's security settings.

| Provider | Incoming (IMAP) | Outgoing (SMTP) | App password |
|---|---|---|---|
| Gmail / Google Workspace | `imap.gmail.com`, 993, SSL | `smtp.gmail.com`, 587, STARTTLS | Needs 2-Step Verification, then [App passwords](https://myaccount.google.com/apppasswords) |
| Zoho Mail | `imap.zoho.com`, 993, SSL | `smtp.zoho.com`, 465, SSL/TLS | [App passwords](https://accounts.zoho.com/home#security/app_password) |
| Yahoo Mail | `imap.mail.yahoo.com`, 993, SSL | `smtp.mail.yahoo.com`, 465, SSL/TLS | [App passwords](https://login.yahoo.com/account/security/app-passwords) |
| Fastmail | `imap.fastmail.com`, 993, SSL | `smtp.fastmail.com`, 465, SSL/TLS | [App passwords](https://app.fastmail.com/settings/security/apps) |
| Outlook / Microsoft 365 | Not with a password | Not with a password | See below |

**Outlook and Microsoft 365** no longer accept passwords for email apps. Connect them in Chatwoot
instead (**Settings → Inboxes → Add inbox → Email → Microsoft**), then choose **Check for new
channels** on Hamnivo's **Channels** page.

## Connect

1. Open **Settings → Channels** and choose **Connect email**.
2. **Your address:** type your support address. **Find my settings** fills in the servers for
   common providers.
3. **Incoming mail:** check the server and port, and type the login and the (app) password.
4. **Outgoing mail:** usually the same login and password. Untick **Same login and password as
   incoming** if yours differ.
5. **Answering:** choose whether the AI answers here (off at first) and which team gets these
   emails.
6. Choose **Connect**. Hamnivo checks that it can sign in. If it can't, it says which setting to
   fix.

## What happens next

- Every new email becomes a **ticket** with its own number, in the Inbox.
- Your replies go out from your support address. The customer's answer comes back to the same
  ticket.
- Delivery reports and `no-reply` senders reach your team, but nothing automatic answers them.

## If it stops working

When your mailbox password changes, the channel shows **Needs attention**. Choose **Fix sign-in**,
type the new (app) password and save.

If it stays like that for 15 minutes, the people who manage integrations get an email and a
banner in Studio. See [When a channel stops working](channels.md#when-a-channel-stops-working).

## Your passwords

Hamnivo passes your passwords to your chat engine (Chatwoot), which keeps them to read and send
your mail. Hamnivo itself stores none, and Studio never shows them again. To change one, choose
**Email settings** → **Change password**.
