# What the assistant can do

Besides answering, your AI assistant can act in the chat: pass the chat to your team, offer
answers to tap, note the contact details a customer gives, and search your knowledge again in its
own words. It also knows which page of your website the customer is on.

## Turn it on

**Make the assistant live** (on Home, **AI agents** or **AI models**) turns all four on. It also
gives the assistant your AI key, your brand's knowledge and memory. To change them one by one:

1. Open **AI assistant**, then **AI agents**, and open your agent.
2. Under **What the assistant can do**, tick or untick each one.
3. Press **Save draft**, then **Publish**.

## What each one does

| Action | When the assistant uses it | What happens |
|---|---|---|
| **Pass the chat to your team when it should** | The customer asks for a person, is upset, or needs something the assistant cannot do or answer. | The assistant says so in its reply. Then the chat goes to your team, with the assistant's summary as a note. |
| **Offer answers to tap** | The customer has to pick between a few options. | Up to six short answers show as buttons under the reply. Tapping one sends it as the customer's message. They can still type. |
| **Note contact details the customer gives** | The customer gives their name, email or phone number. | The details go on the customer's contact (as typed by them, not verified) and in a note in the chat for your team. A malformed email or phone number is left out. The assistant never asks for passwords, card numbers or codes. |
| **Search the knowledge again in its own words** | The first search did not find the answer. | It searches the knowledge ticked for the agent, up to twice per reply. What it finds is cited like the rest. |

Each action happens only once the assistant's reply has gone out. If the reply is held back (by a
check, a person taking over, or the customer pressing **Stop**), nothing it asked for happens.

## The page the customer is on

With each message, the chat sends the address and title of the page the customer is on: the
address without anything after `?` or `#`, which can hold personal codes. The assistant reads it
to understand "this plan" or "this product". It is treated as information, never as instructions.
Nothing is sent for pages that are not web pages.

## Tools from your systems

Tools that only read, such as order or invoice look-ups from a connected billing system (WHMCS),
are given to the assistant by **Make the assistant live**. Tools that change something (a refund,
an address) stay for you to grant, under **Tools**, with their approvals. A WHMCS customer signed
in on your website keeps their link to WHMCS for as long as their chat session lasts, so the
assistant can keep looking things up for them; changes still need the customer's approval with a
fresh sign-in.
