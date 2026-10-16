# Reply-time targets

Reply-time targets say how soon your team should answer a customer who is waiting for a person.
Each conversation shows when its reply is due. When nobody answers in time, it goes to the
**Overdue** queue and your team hears an alert.

## Set the targets

You need a role that configures the inbox (owners, administrators and supervisors have it).

1. Open **Business hours** and choose the brand.
2. Under **Reply-time targets**, turn on **Use reply-time targets for this brand**.
3. For each priority, fill in:
   - **First reply within**: how long a customer may wait for the first answer from a person.
   - **Next reply within**: how long they may wait after they write again.
4. Choose **minutes** or **hours** next to each number. Leave a box empty for no target.
5. Press **Save targets**.

A target is a whole number from 1 minute to 7 days. Conversations with no priority use the
**Medium** targets. Conversations already waiting get the new targets straight away.

## How the time counts

- **Only during your business hours.** A customer who writes at 18:00 when you close at 17:00
  waits until you open the next morning before the clock starts. With no business hours set,
  every hour counts.
- **Only while a person is needed.** The clock starts when a conversation is handed to your team
  and the customer is waiting. It stops while the AI assistant answers.
- **A reply from a person ends it.** A reply from the AI, an automation or an internal note does
  not.
- **Snoozing pauses it.** The time snoozed is added to the deadline when the conversation opens
  again.
- **Resolving ends it.**
- **A new priority changes the deadline.** Making a conversation urgent gives it the urgent
  target, counted from when the customer started waiting.

## What your team sees

Each conversation shows a label with words and an icon, not only a colour:

| Label | Meaning |
|---|---|
| **Reply due in 12 min** | The clock is running. |
| **Reply due in 3 min** (amber) | Less than a fifth of the target is left. |
| **Overdue by 8 min** (red) | Nobody replied in time. |
| **Reply time paused** | The conversation is snoozed. |
| **Reply time waits for opening hours** | It is outside your business hours. |

Hover over the label to see which target applies, for example "First reply target: 15 min".

- **Overdue queue.** Lists the conversations past their target, the most overdue first, with
  their count.
- **Urgent, nobody has taken it.** Above the queue, Studio lists urgent conversations waiting for
  a person, the soonest deadline first. Press **Claim** to take one: it opens, and it is yours.
- **Who got there first.** If a colleague claimed the same conversation a moment before you, Studio
  says so by name, for example "Amina already took this conversation."
- **An alert when a conversation goes overdue.** The owner hears it; for a conversation nobody
  has taken, everyone who can see it does. It uses the sound you chose for "A chat is waiting for
  a person, or is past its reply time" in [sounds and notifications](sounds-and-notifications.md).

## Good to know

- Targets belong to each brand. Other brands keep their own.
- Every change to the targets is in the audit log, and so is each conversation that goes overdue.
- Chatwoot does not show these targets. They live in Hamnivo.
- How often targets are met, by priority and by day, is in [Reports](../reports.md) under
  **Service quality**.
- See also: [business hours](../setup/business-hours.md) and [tickets](tickets.md).
