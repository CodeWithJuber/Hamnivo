# AI drafts

When an AI agent is in **assist mode**, it never answers customers on its own. Instead it writes a
draft reply to each customer message, and a person decides: send it as it is, edit it first, or
reject it. The customer sees nothing until a person sends it.

## Turn it on

1. Open **AI agents** and choose the brand's agent.
2. Set its **Mode** to **Assist staff**, then publish the agent.

Drafts use only the agent's **public** knowledge sources, so every source a draft cites can be shown
to the customer. Sources for your team only are never used in drafts.

## Review a draft

In the **Inbox**, conversations with a draft waiting show **Draft ready**. Open one: the draft sits
just above the reply box, with the sources it cites, numbered as the draft refers to them.

- **Approve and send**: the draft is sent to the customer as you, exactly as written.
- **Edit**: change the text in place, then choose **Send edited**. The reply box is not touched, so
  a half-written reply of yours stays as it was.
- **Reject**: choose why (it is wrong, something is missing, the tone is wrong, no reply is needed,
  or something else) and add a note if you like. Nothing is sent.

Sending a draft works like any reply: if nobody has the conversation yet, it becomes yours. If you
press the button twice, or your connection drops and you try again, the customer gets the reply
once.

## Who can act on a draft

You need a role that can reply to customers. A draft cannot be sent:

- while a colleague handles the conversation. Studio names them; ask them, or take the conversation
  over first;
- on WhatsApp, after the 24-hour reply window has closed;
- once someone has already decided on it. Studio says who, for example "Rayan already decided on
  this draft."

## When a draft is set aside

A draft answers one customer message, for whoever picks the conversation up. It is set aside, and
Studio says why, when:

| What happened | What you see |
|---|---|
| The customer wrote again | A new draft that answers everything they said replaces it. |
| A person picked the conversation up from the queue | Nothing: the draft stays for them. |
| The conversation went to someone else, or back to the AI | The draft is set aside. |
| Someone replied by hand | The draft is set aside: it is no longer needed. |
| The conversation was resolved | The draft is set aside. |

## Good to know

- Drafts are kept for 90 days after they were sent, rejected or set aside, then removed. What was
  decided, by whom and why is in the audit log.
- If a draft was edited, Hamnivo keeps a fingerprint of the text that was sent, not a second copy.
- A draft is different from **Suggest a reply** in the reply box, which asks the AI for a suggestion
  when you want one.
