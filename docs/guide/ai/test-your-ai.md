# Test your AI

Before customers meet a change, you can talk to your AI yourself. **Test your AI** is a scratch
conversation inside the agent editor. It runs the agent with the model it really uses, so you see
what a customer would see: the reply, the pages it used, and every step it took to get there.

It is safe to try anything. Nothing you type is saved, nothing reaches a customer or the inbox, and
no tool is ever run.

## Try it

1. Open **Agents** and choose an agent.
2. Scroll to **Test your AI**.
3. Under **Version to try**, choose the **Saved draft** or the **Live version**.
4. Write what a customer might write and choose **Send**.
5. Read the answer. Keep going to see how it handles a longer talk, or choose **Start over**.

Changes in the form that you have not saved are not in the test. Save the draft first; the page
reminds you when there is something unsaved.

## What it uses

- The agent's instructions, tone and languages.
- The model and the model connection the agent is set to (and its fallback models, if the first
  one is busy). The connection's key never leaves the server.
- The agent's knowledge. A reply to a customer, and a draft in assist mode, draws only on public
  sources, so the test does too. Sources for the team only are never used in answers or drafts.
- The rules of the tools the agent has been given.
- The same checks on the reply as in a live chat: the AI never says it is a person, never says a
  payment or a refund is done without a receipt, and never says something was changed or checked
  without proof.

## What it never uses

- No customer, no earlier conversation and no memory. The AI starts knowing nothing about the
  person it talks to.
- No Chatwoot and no inbox. Nothing appears in a conversation list.
- No tools. When the AI asks for a tool, the test only shows what a live chat would do with the
  request, and tells the AI that this is a test.
- Your brand's Jev checks and the message guard. Those look at real customers' messages; the test
  looks at what your configuration, knowledge and tool rules make the AI do.

## Reading an answer

Under each answer you can see:

- **Sources it used**: the pages the reply cites, numbered like the numbers in the reply. A
  citation to something that was not used is removed, as in a live chat.
- **Tools it asked for**, with what a live chat would do:

  | Shown as | Meaning |
  |---|---|
  | Would run now | The rules let this tool run at once |
  | Would ask for approval | The customer or your team would be asked first |
  | Not allowed | The rules refuse it, for example because the budget of calls is used |
  | Wrong details | The AI sent details the tool does not take |

  Choose **Details it sent** to see them.
- **The model, the tokens and the time** the answer took.
- **Steps**: what happened, in order. *Knowledge search* shows how many passages were found.
  *Model* shows the model that answered, its tokens and its time; with a fallback you see the first
  model fail and the next one answer. *Guard* shows a check that held a reply back, such as
  `honest_identity`, and the reply being written again. *Tool* shows each request.

When a customer asks for a person, the test does not ask the model at all: it shows that a live
chat would go to your team, as it would for real.

## Limits and cost

- Each message uses tokens from your plan and your workspace budget, like a real reply. When the
  tokens are used up, the test stops with a message, but the number of replies in your plan does not
  limit it, because no customer gets a reply.
- You can try 15 messages a minute. A test conversation holds up to 20 messages.
- **Stop AI** stops replies to customers. The test still works, so you can check a fix before you
  turn the AI back on.
- The audit log records that a test ran: the version, the model, the number of tokens and how many
  sources and tools were involved. It never records what was typed or answered.

You need the permission to manage agents (the Owner and Administrator roles have it).

## If it does not answer

| What you see | What to do |
|---|---|
| The model provider refused the key or the account | Check the model connection under **Models** |
| There is no key for this model | Add a model connection first |
| The model connection is off | Choose another connection in the agent's model settings |
| The model provider is busy, or limiting requests | Try again in a moment |
| The model took too long to answer | Try a shorter message, or raise the agent's time limit |
| The conversation is too long for the model | Choose **Start over** |
| There is no saved draft to try | Save the draft, or try the live version |
