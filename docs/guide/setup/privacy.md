# Privacy

**Settings → Privacy** has two parts:

- **How long conversations are kept**: Hamnivo can delete resolved conversations once they are old,
  so your workspace keeps them no longer than it needs to, for example to follow the GDPR or your own
  privacy policy. Nothing is deleted until an owner turns it on. Only owners can change this, after
  signing in again with two-step verification.
- **A customer's data**: when a customer asks for their data, download it as one file; when they ask
  to be erased, erase them everywhere, Chatwoot included. Owners and administrators can do this for
  the brands they handle.

## Choose how long

1. Open **Settings** in the menu, then **Privacy**.
2. Under **Keep resolved conversations**, choose 3 or 6 months, or 1, 2, 3, 5 or 7 years. **Until
   they are deleted by hand** keeps everything, as before.
3. Studio shows how many resolved conversations are older than that today.
4. Select **Save**.

The time counts from a conversation's last message. A conversation the customer writes in again
starts over, and open or snoozed conversations are never deleted.

## A week to change your mind

Turning deletion on, or choosing a shorter time, starts one week after you save. Every owner gets
an email with the date. Until then, **Undo** on the same page cancels it and nothing is deleted.

Choosing a longer time, or keeping everything, applies at once.

## What is deleted

When a resolved conversation is older than the time you chose, Hamnivo deletes:

- the conversation in Chatwoot, with its messages, notes and files;
- everything Hamnivo kept about it: notes, drafts, ratings, read marks and decisions;
- customers left with no conversation and not seen since then, with their Chatwoot contact and
  what the AI remembered about them.

Deleted conversations cannot be brought back.

## What stays

- **Reports** keep their numbers. Hamnivo keeps a row per conversation with times and counts, and
  nothing about the customer or what was said.
- **Orders, payments and refunds** are business records. They stay, and so does the customer they
  belong to.
- **The audit log** stays. It says that conversations were deleted and how many.
- **Consent** a customer gave stays, as proof of what they agreed to.

Data that already left Hamnivo is not reached: webhooks your own systems received, and transcripts
emailed to customers.

## Watch it work

The page shows how many conversations and customers were deleted so far, and when Hamnivo last
checked. The first time can take a while: Hamnivo deletes about 150 conversations an hour.

If it says **Deleting has stopped**, Chatwoot did not let Hamnivo delete. The Chatwoot user Hamnivo
connects with must be an administrator of your Chatwoot account. Nothing is deleted in Hamnivo
either until that is fixed; then deleting starts again by itself.

## Download a customer's data

1. Open **Settings**, then **Privacy**.
2. Under **A customer's data**, type their name, email address, phone number, their ID in your
   own systems, or the ID of one of their conversations (it is in the inbox's address bar when the
   conversation is open), and select **Find**.
3. Select the customer. Studio shows their customer ID and how many conversations, orders and
   memories they have.
4. Select **Download their data**, choose why, add your ticket number if you like, and select
   **Prepare the file**. Studio may ask you to sign in again first.
5. The file is ready after a short while. You get an email, and the request under **Requests**
   shows **Done** with a **Download** button.

The file can be downloaded for 24 hours, and each download is recorded in the audit log. It is a
ZIP with:

- `customer.json`: their profile, and their Chatwoot contact details;
- `conversations/`: one file per conversation, with the messages sent both ways;
- `attachments/`: the files sent both ways, up to 25 MB each and 200 MB in all;
- `consents.json`, `memory.json`, `orders.json`, `feedback.json` and `preferences.json`;
- `manifest.json`, with a checksum for every file and what was left out, and `README.txt`.

**Internal notes are left out.** Staff write them about the customer, and they can name other people.
If you must share them, read them in the inbox and decide what to send.

## Erase a customer

Erasing needs two-step verification, and it cannot be undone.

1. Find the customer as above and select **Erase this customer**.
2. Choose why, add your ticket number if you like, and type the customer ID shown in the dialog.
3. Select **Erase everywhere**.

Hamnivo then deletes, in this order:

- their conversations in Chatwoot, then their Chatwoot contact;
- what the AI remembered about them, with a deletion receipt;
- everything Hamnivo kept about them: profile, conversations, files, feedback, notifications,
  preferences and chat sessions.

What stays:

- **Orders, payments and refunds** stay as business records, without their name, email or delivery
  details. If they bought something, an anonymous record stays for the orders to point at.
- **Consent records** stay, as proof of what they agreed to.
- **Reports** keep their numbers, and **the audit log** says who erased which customer ID and when.
- **A Chatwoot contact shared with another brand** stays, with that brand's conversations.

If the request says **Stopped**, Chatwoot did not let Hamnivo delete: the Chatwoot user Hamnivo
connects with must be an administrator. Nothing was deleted in Hamnivo. Fix that, then erase the
customer again.

An erased customer stays erased after a backup is restored: Hamnivo erases them again, in Hamnivo
and in Chatwoot. An import skips them too.

Data that already left Hamnivo is not reached: webhooks your own systems received, and transcripts
emailed to the customer.
