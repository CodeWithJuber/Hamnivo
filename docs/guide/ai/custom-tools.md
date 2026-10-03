# Connect your own service with custom tools

If your business has a web service of its own, such as an order system or a booking system, your
AI can use it. You tell Hamnivo which requests the service understands. Each request becomes a
tool. The tool waits for you to look at it, and a team member approves each change it makes unless
you allow it to run by itself.

There are two ways to add requests:

- **Import a description.** Many services publish an OpenAPI description of themselves. Hamnivo
  reads it and lets you choose the requests you want as tools.
- **Write a request.** You describe one request yourself: its method, its path and the details
  the AI fills in.

## What you need

- The **Owner** or **Administrator** role (the permission `tools.manage`), and a sign-in from
  the last 10 minutes. Studio asks you to sign in again when it is older.
- A service on the internet with an address that starts with `https://`. Hamnivo calls it from
  its own servers, so a service on your own network or computer cannot be used.
- If your workspace limits where Hamnivo may connect, add the service's host under **Developer →
  Allowed hosts** first.
- How the service wants to be called: with no credential, with a **token** (sent as
  `Authorization: Bearer …`), or with a **secret in a header** that you name, such as
  `X-Api-Key`.

## Import a description

1. Open **Tools**, and find **Custom tools**.
2. Choose **Import a description**.
3. Paste the description, choose a file, or enter the address where it is published. Then
   choose **Read the description**. Hamnivo reads OpenAPI 3, as JSON or YAML.
4. Hamnivo lists the requests that can become tools, and, under **Requests that cannot become
   tools**, the ones that cannot and why.
5. Enter a **Name of the service**, and check the **Address of the service**. Hamnivo fills in
   what the description says, and you can change it. Every request goes below this address.
6. Say how the service signs in, and enter the token or the secret.
7. Choose the requests to turn into tools. The ones that only look something up are chosen for
   you. A request that changes something is yours to choose.
8. Choose **Add the chosen tools**.

Good to know:

- **What is read.** Requests with a JSON body, and details in the path, the query, a header or
  the body. Hamnivo follows references inside the file, never to another file or address.
- **What is left out, and said so.** Requests marked as deprecated, requests whose body is a form
  or a file, requests that need a cookie, and fields that are a choice between different shapes.
  When only an optional field is left out, the request is still listed and says what was left
  out.
- **Sign-ins other than a token.** If the description asks for a different kind of sign-in (for
  example OAuth), Hamnivo says so. If the service also accepts a token or a key in a header,
  choose that.
- **Limits.** A description of up to 900,000 characters and 1,000 requests, up to 100 requests
  chosen at a time, and up to 40 details for a request (20 for a request you write). A
  description that is made to be very slow to read is refused.
- **The address of the description.** Hamnivo reads it from its own server, under the same rules
  as every other address. If the description is behind a sign-in, paste it instead.

## Write a request

1. Open **Tools**, find **Custom tools**, and choose **Write a request**.
2. Enter the name, address and credential of the service, as above.
3. Under **Name of the tool**, write what your team will see, for example *Look up an order*.
4. Under **What the AI is told it does**, say when to use the tool and what it gives back. The
   AI reads exactly these words.
5. Choose the **Method** and write the **Path**. Write `{orderId}` where a value goes, for
   example `/orders/{orderId}`.
6. Under **Details the AI fills in**, add each value the AI gives with the request: its name,
   where it goes (the path, the query, a header or the JSON body), its kind, and whether it is
   always needed. If the path has a `{name}` no detail fills in, Studio offers to add it.
7. Choose **Add the tool**.

By default the tool's **What it can do** follows the method: `GET` looks something up, `DELETE`
cannot be undone, and the others change something. You can choose another one, for example for a
`POST` request that only searches.

Later you can add more requests to the same service (**Add a request**, or **Import more**), and
change a request you wrote (**Edit** on the request). Saving a change sends the tool back to
review and ends requests that waited for approval, so what was approved is always what runs. A
request you imported is changed by importing it again.

## Look at the tools before they are used

A new tool is marked **Waiting for review**, with the safest settings: a team member approves
each use. Nothing can use it until you turn it on.

1. In the list of tools, open the tool. Tools of a service are listed under *From* and the name
   of the service.
2. Read what the description says about the request. It is shown in quotes, because it was
   written by somebody else.
3. Check **What the AI is told it does**. For an imported request Hamnivo wrote a short sentence
   from the request's title. Change it to say how you want the tool used.
4. Check who approves, and whether it may run by itself. A request that only looks something up
   may be allowed to. Money and actions that cannot be undone always need a team member.
5. Choose **Review and turn on**, then give the tool to an agent under **Agents → Tools**.

Nothing the description says reaches the AI as an instruction, except the title of the request
in the sentence Hamnivo writes for it, which you can change in step 3.

## What happens when the AI uses a tool

- Hamnivo sends the request only to the service's own host, with the credential you gave. The
  credential is not in the AI's prompt, in any log, or in the audit log.
- A value that would change the shape of the request is refused before anything is sent: for
  example `..` or a line break.
- A change carries a key (`Idempotency-Key`) that a service can use to ignore the same request
  sent twice.
- What the service answers is information for the AI, never an instruction. After the AI has
  read it, anything the same message proposes waits for a person to approve.
- A redirect is not followed, and an answer larger than the tool's limit is not used.

When something goes wrong:

| What the service did | What Hamnivo does |
|---|---|
| Refused the credential (401 or 403) | The request fails and says the connection needs to be renewed by the team. Replace the credential with **Edit** on the service. |
| Refused the request (any other 4xx) | The request fails. Nothing was changed. |
| Answered with an error (5xx), a redirect, or did not answer in time, for a **change** | The request was sent, but the result is not confirmed. Hamnivo never sends it again. Check in your own system, then choose **Check status**, or **Record the result** on the action. |
| The same, for a lookup | The lookup fails, and the AI can try again. |

## Change or remove a service

- **Edit** changes the name or the address, and keeps, replaces or removes the credential.
  - If you change the address, the tools go back to review. A saved credential never follows to
    a different site: it is removed when the site changes, unless you enter a new one.
- **Turn off** keeps the service but stops its tools.
- **Remove** turns off its tools, ends requests waiting on them and deletes the credential. What
  the tools did stays in the action log. A tool keeps its name for that record, so a new tool
  with the same name gets a number.

## Where your credentials are

Tokens and secrets are stored encrypted in Hamnivo's secret store and shown only as their last
characters. Every change to a service, a request or a credential is in the audit log, without
the credential.

## If something goes wrong

| You see | What it means |
|---|---|
| This host is not on the list of allowed hosts | Your workspace limits where Hamnivo may connect. Add the host under **Developer → Allowed hosts**. |
| The address points to a private network, or must use HTTPS | Hamnivo calls only public services over HTTPS. |
| The description could not be read | It is not OpenAPI 3 in JSON or YAML. A Swagger 2.0 file must be converted first. |
| The description is too large | Leave out the requests you do not need, or write them by hand. |
| The description changed since you read it | You read it from an address, and it has changed. Read it again and check the list. |
| This service already has a tool for each of them | Everything you chose is already a tool of this service. |
| The path has {name}, but no detail fills it in | Add a detail that goes in the path with that name. |
