# Connect other services with MCP

MCP is a standard way for your AI to use another service: look up a ticket in your help desk,
read a page in your wiki, check a payment. You connect the service once in Studio. Its tools
then wait for you to look at each one before any agent can use it.

Nothing a service says reaches the AI as an instruction. Its descriptions are shown to you in
quotes, and the AI gets Hamnivo's own words for each tool instead.

## What you need

- The **Owner** or **Administrator** role (the permission `tools.manage`), and a sign-in from
  the last 10 minutes. Studio asks you to sign in again when it is older.
- A service that runs a **remote MCP server**: an address that starts with `https://`. Hamnivo
  connects to servers on the internet only. It does not start programs on your computer.

## Connect a service from the list

1. Open **Tools**, and find **Connected services**.
2. Choose **Connect a service**.
3. Under **Start from a service**, pick one. The name and the address fill in for you. Under the
   list you see what it is for, how you sign in, and a link to the service's own page about the
   address.
4. Choose **Connect**.
5. If the service signs in with your browser, you go to the service, sign in, and allow Hamnivo.
   You come back to Studio by yourself. Hamnivo then lists the service's tools.
6. If the service wants a token instead, paste the token it gave you in the **Access token**
   field before you choose Connect. It is stored encrypted, and only its last characters are
   shown again.

The list holds only services whose own documentation names their address. Each entry says on
which day Hamnivo last checked the address against that page. If your service is not in the
list, choose **Another service**, and type its address yourself.

| Service | Signs in with |
|---|---|
| Intercom (US and EU) | Browser, or a token |
| Gorgias | Browser |
| Stripe | Browser, or an agent API key |
| Klaviyo | Browser |
| Calendly | Browser |
| Linear | Browser, or a token |
| Notion | Browser |
| Atlassian (Jira and Confluence) | Browser |
| Asana | Browser |
| monday.com | Browser, or a token |
| Sentry | Browser |
| GitHub | A personal access token |

Some well-known services are not in the list on purpose: they let only approved apps connect,
or their documentation does not give an address Hamnivo can use. You can still connect any
service that works with a token by typing its address.

## Sign in with your browser

Services that support OAuth let you sign in without Hamnivo ever seeing your password:

1. Under **Connected services**, choose **Sign in** on the service.
2. Choose **Continue to the service**. You go to the service's own sign-in page.
3. Sign in there and allow Hamnivo. You come back to a page that says **Signed in**.

Good to know:

- **Ten minutes.** A sign-in that is not finished in ten minutes is forgotten. Start it again.
- **One person.** Only the person who started a sign-in can finish it.
- **A client ID.** A few services do not let Hamnivo register itself. Studio then asks for a
  **client ID**. Create an app in the service's own developer settings, use the redirect
  address Studio shows, and enter the client ID (and the secret, if the service gave one).
- **It renews itself.** Hamnivo renews the access before it ends. If the service stops
  accepting the saved sign-in, the service shows **The sign-in stopped working**. Choose
  **Sign in again**.
- **Sign out.** **Sign out** tells the service to forget the access and deletes what Hamnivo
  saved. The tools stay in the list, but they cannot run until you sign in again.

## Look at the tools before they are used

After a service is connected, choose **Check tools**. New tools appear in the list marked
**Waiting for review**, with the safest settings. Open each one, read what it does, and turn it
on when you are happy with it. Then give it to an agent under **Agents → Tools**.

A tool that changes something still asks a person to approve each use, unless you allow it to
run by itself. Money and irreversible actions always need a team member.

## Change or remove a service

- **Edit** changes the name, the address or the token.
  - A new token replaces the old one and ends a sign-in.
  - If you change the address, the tools go back to review and Hamnivo reads the service's
    list again. A saved token stays only if the new address is on the same site. A sign-in always
    ends, because it was made for the old address. This is so a token is never sent to a
    different site.
- **Turn off** keeps the service but stops its tools.
- **Remove** turns off its tools, cancels requests waiting on them, and deletes its token or
  sign-in. What the tools did before stays in the action log. You can connect the same address
  again later; it starts as new, with its tools waiting for review.

## Let agents read a service's documents

Besides tools, a service can offer **resources** (documents and data) and **prompts** (ready
made requests).

1. On the service, choose **Resources and prompts**.
2. The window lists what the service offered the last time it was checked, in quotes.
3. Switch on **Agents may read this** for each resource an agent may read. Nothing is on until
   you switch it on.
4. Under **Tools**, add the **Read a resource** tool and give it to an agent.

An agent with that tool can list the resources you switched on and read them, a part at a time.
What it reads is information for answering a customer, never an instruction: after an agent has
read a resource, any change it proposes waits for a person to approve it. Prompts are listed
for you to see; agents do not use them.

## Where your credentials are

Tokens, refresh tokens and client secrets are stored encrypted in Hamnivo's secret store and
shown only as their last characters. They are never put in a prompt, a log or the audit log.
Every connect, sign-in, change and removal of a service is in the audit log.

## If something goes wrong

| You see | What it means |
|---|---|
| This host is not on the list of allowed hosts | Your workspace limits where Hamnivo may connect. Add the host under **Developer → Allowed hosts**. |
| The server did not accept the sign-in or token | The token is wrong or ended. Sign in again, or enter a new token. |
| The saved sign-in no longer works | The service no longer accepts the sign-in. Choose **Sign in again**. |
| The sign-in service did not answer | Try again in a moment. The saved sign-in is not changed. |
| This service does not let Hamnivo register itself | Enter a client ID from the service's developer settings. |
| This server did not ask for a sign-in | The service needs no sign-in. Use a token only if it asks for one. |
