# Automations

Automations do routine work for you. One can greet a customer, step in when nobody has answered,
show a prompt on your pricing page, or make a ticket after hours. Each one says **when** it runs,
**if** what must be true, and **then** what it does.

## Open it

1. Open **Settings** in the menu, then **Automations**.
2. Choose your brand under **Brand**.

The page has two lists:

- **On your website**: prompts next to the chat button, shown to visitors before they write.
- **In chats**: rules that act inside conversations.

Each automation shows what it does in one sentence, whether it is on, and, for chats, how often it
ran this week.

## Start from a template

Choose **New automation**, then pick a template:

| Template | What it does |
|---|---|
| **Welcome reply** | Thanks a customer who is waiting for a person. |
| **Chat rescue** | Apologises when nobody has replied for 90 seconds, and marks the chat high priority. |
| **Returning visitor prompt** | Greets visitors on their third visit or later. |
| **Help on the pricing page** | Offers help after 30 seconds on a page whose address contains /pricing. |
| **Out-of-hours reply** | Tells customers who write after hours when you will answer, and makes a ticket. |
| **Tag by page** | Tags chats that start on your checkout page. Choose the tag first. |
| **Start from scratch** | An empty automation. |

A template opens as a draft. Nothing runs until you publish it.

## When, If, Then

### 1 When

Website automations run when a visitor has been on a page for some seconds.

Chat automations run when:

- **a chat starts**: the customer's first message;
- **a customer is waiting**: nobody has said anything to them for the seconds you choose (30
  seconds to an hour) since their last message;
- **a chat closes**;
- **a message comes from the contact form** (when nobody could answer). Such a message does not
  count as a chat starting.

### 2 If

Add up to 10 conditions, then choose whether **all** of them or **any** of them must be true:

- **Page address** and **came from** (the referrer): contains, starts with, is, or does not contain.
- **Visits**: at least or at most a number.
- **Country**, **device**, **language**.
- **Business hours are open** and **anyone is online**.
- In chats only:
  - **signed in**;
  - **who has the chat**: the AI, nobody yet, or a person;
  - **tag**;
  - **team**.

When a fact is not known (for example the country, or the page when visitor tracking is off),
a condition about it is never true. An automation never acts on a guess.

### 3 Then

Add up to 5 actions:

- Website: **show a prompt**. Choosing it opens the chat with the same words.
- Chats:
  - **send a message**, as your brand, in the customer's language;
  - **add a note** for your team;
  - **add a tag**;
  - **set the priority**;
  - **assign a team**;
  - **make it a ticket**.

## Try it

The **Try it** panel lets you describe a sample visitor or chat and shows what would happen:

- ✓ or ✗ for each condition;
- whether the automation would run;
- what each message would look like.

It uses the same checks as the real thing.

## Publish, turn off, go back

- **Save draft** keeps your changes without running them.
- **Publish** makes the draft the version that runs. Each publish is kept as a new version.
- The switch on the list turns an automation off without deleting it.
- Under **Versions**, **Restore** copies an earlier version into the draft. Publish it to use it
  again.
- **Recent runs** lists what a chat automation did, conversation by conversation. Runs are kept for
  90 days.

If someone else saved the automation after you opened it, Studio asks you to reload rather than
overwrite their work.

## Safety rules

- An automation never speaks while the AI is answering a chat. To send a message, an automation
  must include the condition **Who has the chat is not the AI**, and match **all** conditions.
  Studio shows this before you publish.
- An automation acts at most once per chat for each event. Messages it sends never start another
  automation.
- At most five automated messages reach one chat in a day.
- No message is sent after a chat closes.
- Website prompts keep to your **Prompt limits**: at most 1 to 3 prompts a day for one visitor,
  and a quiet time after they close one. Prompts never show over an open chat.

## Who can use it

- Administrators and owners can create, publish and turn off automations.
- Supervisors can see them and what they did.
- In custom roles, these are **View automations and what they did** and **Create, publish and
  turn off automations**.

Good to know:

- The proactive prompts you had before are now website automations, published and on or off as
  they were.
- Country is read from the visitor's connection for each visit and never stored.
