# Saved replies and tags

**Saved replies** are answers you write once and your team reuses. **Tags** are labels your team puts
on chats to sort and find them. You set both up in Studio, in one place, and a change reaches
everyone at once. You do not need to open Chatwoot.

You need permission to manage the inbox to change them. Everyone else on your team can still use
them: they pick a saved reply while answering a chat, and a tag from the chat's details.

## Open the page

1. Open **Inbox**.
2. Select **Saved replies and tags** above the list of chats.

You can also reach it from a chat's details: when a brand has no tags yet, you see **Add tags**
there. Select **Back to inbox** to return.

If you look after more than one brand, use **Brand** at the top to choose which brand's saved
replies and tags you see. Each brand has its own.

If you see "Chat is not set up for this brand yet", connect the brand to chat first (see **Settings,
Brands and install**). Then come back.

## Saved replies

### Add a saved reply

1. In **Saved replies**, select **Add a saved reply**.
2. Write a **Short code**. This is the short name your team searches for, such as `refund-policy`.
   Use letters, numbers, `-` and `_`, with no spaces. Each short code can be used once.
3. Write the **Text** of the reply, up to 5,000 characters.
4. To use a detail from the chat, select **Customer's first name**, **Customer's full name**,
   **Your name** or **Brand name**. The detail is added where your cursor is, and it is filled in
   when someone uses the reply. For example:

   > Hi {{contact.first_name}}, this is {{agent.name}} from {{inbox.name}}. How can I help?

5. Select **Add saved reply**.

Your team can use it straight away. While answering a chat, they select **Saved replies** next to the
reply box, search, and pick it.

Good to know:

- If a detail is not known for that customer, the person using the reply sees which ones to fill in
  by hand. Studio never makes up a customer's name, and it only fills in an email address the
  customer's website has verified.
- A saved reply is a starting point. The person can change the words before sending.

### Change or delete a saved reply

1. Find it in the list. With many saved replies, use **Search saved replies**.
2. Select **Edit** to change the short code or the text, then **Save**. Or select **Delete** and
   confirm.

Deleting removes it for everyone. Messages that were already sent do not change.

## Tags

### Add a tag

1. In **Tags**, select **Add a tag**.
2. Write a **Name**, such as `vip` or `order-problem`. Use at least 2 letters or numbers; `-` and `_`
   are fine after the first one. No spaces. Names are kept in lower case.
3. Optionally, write a **Description** to remind your team what the tag is for.
4. Choose a **Colour**.
5. Select **Add tag**.

Your team can put it on chats straight away: open a chat, find **Tags** in its details, choose the
tag and select **Add**.

> **Hindi and other scripts with vowel signs.** The chat service accepts only plain letters and
> numbers in a tag name. Letters with vowel signs, such as Hindi words, are refused, so write the
> name in English letters, for example `vip`. Saved replies have no such limit.

### Change a tag

1. Find it in the list and select **Edit**.
2. Change its name, description or colour, then **Save**.

If you change the **name**, the tag is renamed on every chat that has it, and the filters and the
list of chats use the new name.

### Delete a tag

1. Find it in the list and select **Delete**.
2. Confirm.

The tag disappears from the list your team picks from, **and from every chat that has it**. This
cannot be undone: if you need the tag again, add it again and put it back on the chats.

## Who did what

Each change is recorded in the audit log with who made it: adding, changing and deleting saved
replies and tags, and renaming a tag (with how many chats it reached). The log shows short codes and
tag names, not the text of your replies.

## If something goes wrong

- **"Another saved reply already uses this short code"** or **"A tag with this name already
  exists"**: choose a different name. Names are compared without regard to upper and lower case.
- **"Saved replies and tags are not available to you"**: your role does not include managing the
  inbox. Ask an administrator.
- A message saying the chat service did not answer: wait a moment and try again. Nothing was
  changed.
