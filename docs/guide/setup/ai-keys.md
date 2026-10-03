# AI keys

An **AI key** is what lets your AI assistant write answers. It is like a password that connects
Hamnivo to an AI company, such as OpenAI, Anthropic or Google. You get one from that company's
website, in the part for API keys. You may have to add a payment method there first.

In Studio, AI keys are on the page called **Model connections**. Open **AI assistant** in the
menu, then **Model connections**. Only an owner or administrator can open it.

Keys are kept encrypted. After you save a key, Studio never shows it again, only its last four
characters. Do not share a key with anyone you do not trust, and do not paste it into chats or
emails.

## Add a key

1. Press **Add connection**.
2. Choose the **Provider**: the company that gave you the key.
3. Paste the key into **API key**.
4. Check the **Model**. A model is the AI itself. The one marked **recommended** is a good place to
   start. If yours is not in the list, choose **Another model…** and type its name exactly as the
   provider writes it.
5. Optionally give it a **Label**, such as "OpenAI production". Left empty, Studio uses the
   provider's name.
6. Press **Save and test**.

Under **More options** there are two settings that most people never need:

- **Server address**: only for a server of your own that works like OpenAI's. For that provider
  it is required, and so is the model name, because each server names its own models.
- **Allowed models**: limits which models your agents may use with this key. Empty means any.

## What the test tells you

When you press **Save and test**, Studio saves the key, then sends one tiny message of a few
words to the provider. It costs a tiny fraction of a cent. Nothing is added to your customers'
chats. You see the answer in plain words:

| What it says | What it means | What to do |
|---|---|---|
| **The key works** | The AI answered. | Nothing. You are done. |
| **The key wasn't accepted** | The provider did not recognise the key. | Check you copied all of it, and that it belongs to this provider. Press **Replace key** to paste it again. |
| **No credit left** | The key is real, but the account has no money on it. | Add credit with the provider, then press **Test again**. |
| **Model not found** | The provider does not know that model name. | Test with another model from the list, or check the spelling. |
| **Couldn't reach the provider** | Studio could not connect. | If you typed a server address, check it. Try again in a minute. |
| **That server address isn't allowed** | The address is not a public `https://` one. | Use a public `https://` address, or ask whoever runs your Hamnivo server. |
| **The provider says slow down** | Too many requests just now. | Wait a minute and test again. |
| **The provider is having trouble** | A problem at the provider. | Try again in a few minutes. |
| **The test didn't work** | We do not know why. | Try again. If it keeps failing, check the key and the model with the provider. |

A key that failed is still saved. You can fix it from the list, or disable it.

## Test a key again

In the table, each key has a **Last test** column, which says whether it worked and when. To test
it again:

1. Find the key and press **Test key**.
2. Studio tests it at once. To try another model, choose it and press **Test again**.

## Replace a key

Use this when a key was lost, leaked, ran out or changed:

1. Find the key and press **Replace key**.
2. Paste the **New API key**.
3. Press **Replace and test**.

You may be asked to sign in again first. That is a safety step. Your AI agents carry on with the
new key without any change. The old key stops working in Hamnivo straight away. If you think the
old key leaked, also delete it at the provider.

## Turn a key off

Press **Disable** on the key. Agents that use it stop answering until you choose other
credentials. A disabled key is revoked and cannot be recovered.

## Keys on this server

Below the table, **Keys on this server** shows what whoever runs your Hamnivo server has set up.
It shows only yes or no, never a key:

- **A key for each provider.** If the server has one, your agents can use that provider without a
  connection of your own.
- **Jev.** It sends questions to the right place and double-checks answers. It is optional.
- **Knowledge search.** **Basic** means simple word matching, which is fine for trying things out.
  **By meaning** needs an OpenAI or Google key on the server.

## Common questions

**Do I need a key at all?** Without one, your agents can use only the keys the server already
holds and an offline practice model that gives canned replies. For a real AI assistant, add one.

**Which model should I pick?** Start with the recommended one. It is fast and costs little. Pick
a more capable one only if the answers need it.

**Who pays for the AI?** The provider charges the account the key belongs to, for what the AI
uses. The test costs a tiny fraction of a cent.
