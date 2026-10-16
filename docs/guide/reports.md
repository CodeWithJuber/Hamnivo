# Reports

**Reports** shows how your conversations went: how many there were, how many the AI resolved or
handed to people, how fast people answered, what customers thought, and how your team handled
the work. Reports show totals only, never message text or customer names.

You need the **View analytics and reports** permission. Billing has its own tab and permission.

## Choose what to look at

At the top of each tab:

- **Dates**: the last 7, 30 or 90 days, or your own range of up to a year. Days are counted in
  your computer's time zone, shown under the filters.
- **Team** and **Channel**: show only one team's queue or one channel.

**Export CSV** downloads the same numbers, with the same filters, as a spreadsheet file.

## The tabs

| Tab | What it shows |
|---|---|
| **Service quality** | Conversations, handoffs, resolved, customer feedback, median first response and time to resolve; chats that went wrong (missed, contact form messages, reopened); **reply-time targets**; conversations per day against the period before; why conversations went to people; orders and refunds. |
| **Team activity** | Each team's conversations, first response, handoff rate and feedback; channels; **chats offered to one person at a time**. |
| **Tickets** | Tickets created, closed and open now, the median time to close, by priority and by source. |
| **AI usage** | AI replies and tokens, chats handed to people at the plan's limit, the answer cache; **AI drafts for review**. |
| **Billing** | Usage against your plan, budgets and invoices. |

### Reply-time targets

How often a person answered within the brand's [reply-time target](inbox/reply-targets.md).

- **Targets met**: the share of replies from a person that came in time.
- **Targets missed**: replies that came after the target.
- **Median time to first reply**: working time, without the time a conversation was snoozed.
- **Ended without a reply**: the AI took the chat back, or it was resolved, before a person
  replied. These are counted apart and never count as missed.
- **By priority** and **By day**: the same share for each priority and each day with replies.

A target is counted on the day its clock ends. Hamnivo started recording this with this release,
so the report says from which date it has results.

### Chats offered to one person at a time

For teams that [offer chats](inbox/offers.md):

- **Accepted**: the share of offers that were accepted, out of those answered or left to run out.
  Offers that ended because someone else took the chat are left out.
- **Declined** and **Ran out**: how many, and their share.
- **Median time to accept**.
- **Left in the queue**: hand-offs nobody accepted, so the chat waited for anyone to take it.
- **Why people declined**, and each team's offers and share accepted.

### AI drafts for review

For agents that [write drafts for a person to check](inbox/ai-drafts.md):

- **Sent**: the share of drafts people approved, as written or edited, out of those they decided on.
- **Edited before sending** and **Rejected**: how many, and their share.
- **Why drafts were rejected**, **why they were set aside** without a decision (for example, the
  customer wrote again), and each AI agent's drafts and share sent.

## Small numbers are withheld

To protect privacy, a number that stands on fewer than 5 conversations, responses, offers or
drafts shows **Small sample** instead. Where a total is shown, the next smallest number is
withheld too, so the hidden one cannot be worked out. For example, when only 2 replies missed
their target, the number met is withheld as well, because the total of replies is shown. The CSV leaves those cells empty. Your
server administrator can change the 5 (`ANALYTICS_MIN_GROUP_SIZE`).

## How far back reports go

| Report | Kept for |
|---|---|
| Conversations, feedback, tickets, orders | Since reports started recording on your server |
| Reply-time targets | 13 months |
| Offers and AI drafts | 90 days |

When the dates you choose start earlier than that, the report says so, and only the days it still
has are counted.

## Good to know

- Chats an owner opened to try the chat widget are left out of every report.
- A person whose access is limited to some brands, teams or inboxes sees only those.
- An API key with **View analytics and reports** can read the same numbers from
  `GET /v1/admin/analytics/overview` and `GET /v1/admin/analytics/export`.
