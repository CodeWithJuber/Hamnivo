# Getting started

This guide takes you from a new account to a chat on your website that answers your customers.
You do it all in **Hamnivo Studio**, the web page where your team works. You do not need to be a
developer. It takes about ten minutes, and you can stop and carry on whenever you like.

## What you need

- Your Studio sign-in. If you do not have one yet, create an account and a workspace.
- The address of your website, such as `noor.example`.
- An **AI key**, if you want the AI assistant to answer. You get one from an AI company such as
  OpenAI, Anthropic or Google. [How to add it](ai-keys.md). You can do this step later.

## Open the guided setup

The guided setup opens by itself right after you create a workspace. To open it again:

1. Open **Home** in Studio.
2. In the box called **Get set up**, press **Open guided setup**.

The page is called **Welcome to Hamnivo**. On the left is a list of the seven steps. A tick means
the step is done. A dash means you skipped it. A number means it is still to do. You can open any
step from the list, in any order.

Every step has two ways out at the bottom: **Back**, and **Skip this step**. Skipping loses
nothing. The step stays in the list and you can do it later. **Finish later**, at the top right,
takes you back to Home. Hamnivo remembers where you were, even on another computer.

## The seven steps

### 1. Workspace

Your workspace is where everything about your business lives. It is already made. Press
**Continue**.

### 2. Brand and website

A **brand** is one business or shop that has its own chat. Each brand has its own chat, its own
website and its own AI assistant.

1. Type the **Brand name**. Customers see it at the top of the chat.
2. Type **Your website**, such as `noor.example`. Only this website may show your chat. You can
   leave it empty and add it later.
3. Press **Create brand**.

If your workspace already has a brand, the step lets you carry on with it, or add a different one.

### 3. Chat engine

The chat engine carries your customers' messages to your team. You do not set it up yourself:
Studio starts it as soon as you open the step. Wait for **Your chat engine is ready.** Then press
**Continue**. If it says it could not finish, press **Try again**.

Only an owner or administrator can do this step. If you are neither, the step says so, and you can
skip it.

### 4. AI key

An AI key is what lets your AI assistant write answers. Choose who gave you the key, paste it,
and press **Save and test**. Studio sends one tiny message to check the key works, and tells you
what happened in plain words. [All the details are here](ai-keys.md).

### 5. Test chat

This is your real chat, inside Studio. Send yourself a message and see what comes back, before any
customer sees it. [More about the test chat](test-chat.md). Press **It works, continue**.

If this step says to connect the chat engine first, go back to step 3.

### 6. Install

This puts the chat on your website.

1. Under **Where is your website built?**, choose the tool your website is made with, such as
   WordPress or Shopify. If you are not sure, keep **Any website**.
2. Press the link **Open the installation guide** to read the steps for that tool.
3. Press **Copy install code**.
4. Paste it where the guide says. On most websites that is every page, just before the closing
   `</body>` tag, or in a box for custom code in the footer.
5. Open any page of your website. A chat button should appear in the corner.
6. Back in Studio, the box **Waiting for your website** turns green and says **The chat is on your
   website**, with your website's address. You don't need to do anything: it checks again every
   few seconds, or press **Check now**.
7. Press **I've added the code**.

Hamnivo knows the code works when a page of your website loads the chat. It notes only your
website's address and the time, nothing about your visitors. Home shows it too: each brand says
when its chat was last seen on its website.

If the box stays on **Waiting for your website**, open **Not showing up?**:

- The page's address must match a website on the allowed list exactly, including `https` and
  `www` if you use it.
- Open the page again after saving it, or clear your website's cache, so it uses the new code.
- If your website has a content security policy, it must allow Hamnivo's scripts, frames and
  connections.

Send a message from your website to try it: it shows up in your **Inbox**.

If the step warns that no website is allowed yet, press **Add your website**. Only a website on
the allowed list can show the chat.

### 7. Team

Add the people who will answer chats with you.

1. Press **Invite a teammate**.
2. Type their **Email address**, choose a **Role** (what they may do) and where it applies.
3. Press **Send invite**. They get an email with a link that works for 7 days. If email is not
   set up on your server, copy the link Studio shows and send it to them yourself.

You can change what they may do later, and invite more people later from **Team and access**.
Press **Finish setup** when you are done, or skip the step.

## After the guided setup

For the assistant to act on a client's WHMCS account (services, invoices, tickets), Home shows a
box called **Make the AI assistant work** until everything is in place. It lists seven steps in
order: an AI key that works, a live agent on a real model, a customer sign-in key, WHMCS
connected, the agent allowed to use WHMCS, no demo tools, and your website signing customers in.
Each step says **Done**, **To do** or **Needs attention**, what is wrong in plain words, and has
one button to the page where you fix it. The last step cannot be checked from Studio: its button
opens the guide that shows how to test it.

Two more things make the chat useful:

- **Make the assistant live.** The AI assistant only answers customers once it is live on a real
  AI model. Home, **AI agents** and **AI models** show a red card for each brand whose assistant is
  not live yet: press **Make the assistant live**. In one step it uses your newest AI key (or your
  server's), the brand's knowledge (its website included, see below) and
  [memory](../ai/see-what-the-ai-remembers.md) for customers who agree, then publishes it. You can
  change any of it later in the agent's editor.
  [What the assistant can do](../ai/what-the-assistant-can-do.md).

  Until then the assistant is on an offline test model that gives every customer the same fixed
  reply. A production server never lets that model answer: those chats go to your team, with a note
  saying why.
- **Your website is already the AI's knowledge.** When a brand has a website (an `https://`
  address on its allowed list), Hamnivo starts reading it at once, the same way as
  [adding a website yourself](../ai/teach-your-ai-your-website.md).
- **Set your business hours**, so the chat tells customers honestly when a person can answer.
  [How](business-hours.md).

You can also change [how the chat looks](widget-look.md): its colour, logo and words.

## If something goes wrong

| What you see | What to do |
|---|---|
| The setup page says you may not open it. | Ask an owner or administrator. Setting up needs permission to manage brands. |
| **Try again** under the chat engine step keeps failing. | Wait a minute and try again. If it still fails, tell whoever runs your Hamnivo server. |
| The AI key test fails. | Read the message under it. [What each message means](ai-keys.md#what-the-test-tells-you). |
| The chat button does not appear on your website. | Check the code is on every page, and that the website is on the allowed list for the brand (**Brands and install**). The address must match exactly, including `www` if you use it. |
| You left in the middle. | Open **Home**, then **Open guided setup**. You carry on where you stopped. |
