# See what the AI remembers

When a customer agrees to be remembered, the AI keeps a few things they told it: their preferred
language, how to address them, a delivery note. It uses them in later chats so the customer does
not have to repeat themselves. You can see what is remembered beside the conversation, where it
came from, and correct or delete it.

Nothing is remembered about a customer who has not agreed, and the customer can change their mind
at any time.

## Where to look

1. Open the **Inbox** and choose a conversation.
2. In the panel on the right, under the customer, find **What the AI remembers**.

For everything about a customer, including their choice history, exporting what is remembered and
erasing it all, choose **Open memory** there, or open **Memory** in the menu.

When a customer asks for all their data, or to be erased everywhere and not only from memory, use
**Settings → Privacy** instead: see [Download a customer's data](../setup/privacy.md#download-a-customers-data)
and [Erase a customer](../setup/privacy.md#erase-a-customer).

## What you see

- **Their choice**: *Memory on*, *Declined*, *Memory off* or *Not asked yet*, with the day they
  chose.
- **Each memory** with what it is (for example *Preferred language*) and what it says.
- **Where it came from**, with the day: *Customer message*, *Set by the customer*, *Entered by
  staff* or *Inferred*. When it came from the conversation you have open, the line ends with
  *this conversation*.
- **Needs review**: a newer, different value waits for someone to confirm it. It is not used in
  replies until then. Choose **Review** to compare the two on the Memory page.

If the card says nothing is remembered, there are three usual reasons: the visitor is not a known
customer yet, they have not agreed to be remembered, or the brand's AI does not use memory (turn
it on in the AI agent's settings).

## Correct a memory

If a value is wrong:

1. Choose **Correct** on the memory.
2. Type the new value and the reason. Keep personal details out of the reason: it is kept with the
   change.
3. Choose **Save correction**.

The new value replaces the old one in later replies. The old one stays in the history, so you can
always see what changed and why.

## Delete a memory

If the AI should not keep something at all:

1. Choose **Delete** on the memory.
2. Type the reason and choose **Remove from future use**.

It is no longer used in replies. A record that it was removed, and why, stays in the audit log. You
may be asked to sign in again first.

## Who can see and change it

| You can | You need |
|---|---|
| See the card and what is remembered | The permission `memory.read` for the conversation's brand (Owner, Administrator and Supervisor have it) |
| Correct a memory, and review one that waits | `memory.manage` |
| Delete a memory | `memory.delete` |

Support agents see the conversation but not the card. The card does not appear for a conversation
you cannot see.

The card shows the same memories as the Memory page: the values in use and the ones waiting for
review. Older values and the history of changes are on the Memory page.
