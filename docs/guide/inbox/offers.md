# Offering chats to one person at a time

By default, a chat handed to a team waits in the team's queue, and everyone in the team sees it.
A team can instead **offer** each chat to one person at a time. That person accepts it or
declines it. If they decline, or don't answer in time, the next person is offered it.

## Turn it on for a team

1. Open **Support teams**.
2. On the team, choose **How chats arrive**.
3. Choose **Offer it to one person at a time**, and set the **Seconds to accept** (15 to 600,
   60 by default).

You need permission to manage teams.

## Who is offered a chat

Hamnivo picks someone from the team who can take the chat now. To be picked, a person must:

- be **online**: Studio is open and in use, and their status is Online;
- not be holding another offer;
- have fewer open chats than their limit, if they have one.

Among those people, Hamnivo prefers, in this order:

1. someone who speaks the customer's language;
2. the person with the fewest open chats;
3. the person who has waited longest since their last offer.

Each chat is offered to at most three people, and never to the same person twice for the same
hand-off. After three people, or when nobody can take it, the chat waits in the team's queue.
Everyone in the team is then alerted, as for any waiting chat.

Email isn't offered. It waits in the queue as before.

### Languages and limits

At the bottom of **Support teams**, under **Languages and limits**, choose **Edit** for a person
and set:

- the languages they answer in. Hindi covers Hinglish, and Urdu covers Roman Urdu.
- the most open chats they take at once, from 1 to 50. Leave it empty for no limit.

## Answer an offer

A chat offered to you appears under **Offered to you**, at the top of the **Inbox**, with the time
left to answer. You also hear your "assigned" sound, and get a desktop alert if you turned those on.

- **Accept**: the chat becomes yours and opens.
- **Decline**: choose why: you have too many chats, it isn't your area, you're going offline, or
  something else. You can add a note. The chat is offered to the next person straight away.
  If you choose **I am going offline**, your status becomes Away, so you aren't offered more chats.

If you set yourself to Away or Offline while a chat is offered to you, it goes to the next person
straight away.

## An offer is not ownership

While a chat is offered, it stays in the queue. Your colleagues see **Offered to Amina · 0:42** on
it and can still take it. If someone does, or the chat is resolved, snoozed or moved to another
team, the offer ends. If you then try to accept it, Studio tells you who has it now.

## Good to know

- Offers and declines, with their reasons, are kept in the audit log. Ended offers are removed
  after 90 days.
- How many offers were accepted, declined or ran out, and why people declined, is in
  [Reports](../reports.md) under **Team activity**.
- If your team uses Chatwoot's own auto-assignment, turn it off for teams that offer chats. An
  assignment made in Chatwoot ends the offer, like any other claim.
