# Running Hamnivo on your own server

Hamnivo has no hosted CI. You run every check and host every service yourself, with the scripts in
this repository.

- **Part A** puts Hamnivo in production on one server, with HTTPS and backups.
- **Part B** is for development: running the services one by one and running the checks.

## What you can run today

| Part | Status | How |
|---|---|---|
| Production on one server: every service, automatic HTTPS, backups and restore | ready | Part A: `deploy/production/hamnivo.sh` |
| Checks (lint, types, unit, integration on PostgreSQL 16 and 18, Chatwoot contract, accessibility, widget journey and website in a browser) | ready | `pnpm ci:local` |
| Production smoke test (the real deployment on this machine, then a backup and restore drill) | ready | `bash scripts/ci/production-smoke.sh` |
| Automatic deployment from GitHub: webhook and a 5-minute check, checks and build on the server, rollback when unhealthy | ready | A10; tested by `bash scripts/ci/autodeploy-smoke.sh` |
| Infrastructure for development (PostgreSQL 18 + pgvector, Valkey) | ready | `pnpm services:up` |
| Design system (Storybook) | ready | `pnpm --filter @hamnivo/ui storybook` |
| Database schema, row-level security and audit log | ready | `pnpm db:migrate` |
| Gateway API (staff sign-in, tenants, members, roles, grants, secrets, audit) and worker | ready | `pnpm api`, `pnpm worker` |
| Chatwoot CE v4.18.0 (conversation authority) with the Hamnivo Platform App | ready | `pnpm chatwoot:up` |
| Chat API: widget sessions, conversations, live stream, staff takeover | ready | see "Connect a brand to Chatwoot" below |
| Chat widget (Hamnivo Chat), its one-script loader and the JS client SDK | ready (first version) | see "Put the chat on a web page" below |
| Verified customers: the server SDK (`@hamnivo/server`), with examples for plain HTML, Node Express and WordPress | ready (first version) | [`docs/guides/identity.md`](guides/identity.md) |
| Public website (EN/AR/HI/UR, static) | ready | see "The public website" below |
| AI agents: real models (Anthropic, OpenAI, Gemini, OpenAI-compatible), knowledge, kill switches | ready (API) | see "Connect a brand to Chatwoot" below |
| Studio (staff console): sign-in with two-step verification, brands and install, Chatwoot connection, AI agents, model connections, knowledge, Stop AI, runs | ready (first version) | `https://app.<your domain>` (A6); `pnpm --filter @hamnivo/console dev` in development |
| Team and access (members, invitations, custom roles, audit log with export), single sign-on per workspace (OpenID Connect), passkeys, support access | ready (first version) | Studio: Team and access, Security (A6) |
| Platform console for the people who run the server: workspaces (metadata only), service health, support access, incident banners | ready (first version) | `https://app.<your domain>/platform`; operators are named on the server (A7) |
| Developer platform: API keys, signed webhooks (Standard Webhooks) with retries, a delivery log and replays, allowed hosts, webhook checks in the server SDK | ready (first version) | Studio → Developer; [`docs/guides/api-keys.md`](guides/api-keys.md), [`docs/guides/webhooks.md`](guides/webhooks.md) |
| Reports (service quality, teams, AI use, orders) with small groups withheld; plans, usage limits, AI budgets and invoices | ready (first version) | Studio → Reports; plans and invoices: "Plans and invoices" in A7 |

# Part A: Host Hamnivo on your server

## A1. What you need

- **A server** with Ubuntu 24.04 LTS (or another recent Linux), 4 vCPU, 8 GB of memory and 40 GB
  of SSD. Add 2 GB of memory for virus scanning of uploads (ClamAV, on by default).
  - Automatic deploys (A10) build on the server. They keep a build cache and the images of three
    versions: plan 60 GB of SSD, and swap (A2) on 8 GB of memory.
- **A domain** you control, for example `example.com`.
- **DNS records** (A, and AAAA if the server has IPv6) pointing at the server for these names:

  | Name | Serves |
  |---|---|
  | `api.example.com` | the API |
  | `chat.example.com` | the chat widget and its loader script |
  | `support.example.com` | Chatwoot, where staff can also answer |
  | `app.example.com` | Studio, the staff console |
  | `example.com` and `www.example.com` | the public website |

  A wildcard record `*.example.com` covers the first four.
- **With Cloudflare** (its DNS, optionally its proxy):
  - **DNS only** (grey cloud) is the simplest: Caddy gets the certificates itself.
  - **Proxied** (orange cloud) hides the server's address and filters attacks. It needs:
    - SSL/TLS mode **Full (strict)**. Flexible makes an endless redirect.
    - **Always Use HTTPS** off. Caddy redirects to HTTPS itself, and certificates are issued and
      renewed over plain HTTP.
    - `setup --cloudflare on` (A4), so Hamnivo sees each visitor's own address, not Cloudflare's.
    - For automatic deploys (A10): **Bot Fight Mode** off, or the `api` name set to DNS only.
      Otherwise Cloudflare may block GitHub's webhooks.
- **Open ports:** 80 and 443 over TCP, and 443 over UDP (HTTP/3). Caddy, the web server in the
  stack, uses port 80 to get certificates from Let's Encrypt, then redirects it to HTTPS.
- **Email (recommended):** an SMTP account for sign-in and invitation emails.

## A2. Install Docker, git and openssl

```bash
sudo apt-get update && sudo apt-get install -y git openssl
curl -fsSL https://get.docker.com | sudo sh        # Docker Engine and the compose plugin
sudo usermod -aG docker "$USER"                      # log out and back in afterwards
```

A firewall that allows only SSH and the web ports:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

Only the web server publishes ports. The databases, Valkey, the API and Chatwoot are reachable only
inside Docker's network.

Builds (the first start, updates and automatic deploys) run next to the live services. On 8 GB of
memory, a 4 GB swap file keeps a build from pushing the services out of memory:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## A3. Get the code

The repository is private, so the server reads it with its own key, a read-only deploy key.

1. Create the key on the server:

   ```bash
   ssh-keygen -t ed25519 -N '' -C "hamnivo-deploy@$(hostname)" -f ~/.ssh/hamnivo_deploy_ed25519
   cat ~/.ssh/hamnivo_deploy_ed25519.pub
   ```

2. On GitHub, open the repository's **Settings → Deploy keys → Add deploy key**. Paste the key and
   leave "Allow write access" off.
3. Trust GitHub's host key, as GitHub publishes it on docs.github.com (fingerprint
   `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`), so that no first connection has to be
   confirmed blindly:

   ```bash
   echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' >>~/.ssh/known_hosts
   ```

4. Clone:

   ```bash
   sudo mkdir -p /opt/hamnivo && sudo chown "$USER" /opt/hamnivo
   GIT_SSH_COMMAND='ssh -i ~/.ssh/hamnivo_deploy_ed25519 -o IdentitiesOnly=yes' \
     git clone git@github.com:CodeWithJuber/Hamnivo.git /opt/hamnivo
   cd /opt/hamnivo
   git config core.sshCommand 'ssh -i ~/.ssh/hamnivo_deploy_ed25519 -o IdentitiesOnly=yes'
   ```

Run everything as this user, without `sudo` (it is in the `docker` group), or everything as root.
As root, the webhook receiver of automatic deploys still runs as `nobody`. `hamnivo.sh autodeploy
enable` (A10) sets up the same key if you skip this step.

## A4. Configure

```bash
./deploy/production/hamnivo.sh setup --domain example.com --email you@example.com
```

This writes `deploy/production/.env`:

- the public names, derived from the domain;
- the email address that Let's Encrypt uses for certificate notices;
- every password and key, generated.

Running `setup` again only adds settings that are missing. It never changes a password or key.

`.env` holds every secret. Keep it private: it is readable only by you and never goes into git or
an image. Keep a copy somewhere safe, because without it the secrets stored in the database cannot
be decrypted. Backups include it (A7).

Then edit `deploy/production/.env` for:

- **Email:** `SMTP_URL`, for example `smtps://user:password@smtp.example.com:465`, and `MAIL_FROM`.
  In the user name and password, write `@` as `%40`, `:` as `%3A`, `/` as `%2F` and `#` as `%23`.
  If the password has a `$`, put the whole value in single quotes. Examples:
  - Hostinger: `smtps://no-reply%40example.com:PASSWORD@smtp.hostinger.com:465`.
  - Gmail: `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465`. Use an app password
    (Google account → Security → 2-Step Verification → App passwords), and send from that
    address.

  Without `SMTP_URL`, no email leaves the server. Sign-in emails go to the API log instead, and
  `hamnivo.sh mail` shows the latest ones with their links.
- **AI models (optional):** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  or `OPENAI_COMPATIBLE_BASE_URL` for a local model. Each company can also store its own keys
  later. `EMBEDDING_PROVIDER` chooses the model for knowledge search. `ALLOW_MOCK_MODEL=true` lets
  agents answer with the offline `hamnivo-mock` test model, which production otherwise refuses
  (a demo server only).
- **Decisions with Jev (optional):** `TYPESAFE_API_KEY`, a key from [typesafe.ai](https://typesafe.ai).
  It lets brands route conversations with Jev (A6, "Decisions with Jev").
- **Other names:** change `HAMNIVO_*_HOST`, then run `setup` again to update the addresses derived
  from them.
- **Behind Cloudflare's proxy:** run `setup --cloudflare on`. Caddy then believes the visitor
  addresses that Cloudflare reports, but only on connections from Cloudflare's own address ranges,
  which `up` keeps current. Rate limits and the audit log then see each visitor's address.
  `--cloudflare off` undoes it.
- **Behind another web server on ports 80 and 443** (a hosting panel or a load balancer that passes
  the Hamnivo names on to this server): give the edge other ports, and tell `setup` which port
  browsers use: `setup --https-port 8443 --http-port 8080 --public-port 443`. The addresses then
  have no port, and the edge listens on 8443 and 8080. Without `--public-port`, Studio, the API and
  the chat are given addresses with `:8443`, which browsers cannot reach through that web server.
- **Chatwoot's email:** copy `deploy/production/chatwoot.env.example` to `chatwoot.env` in the
  same folder and fill it in.

`deploy/production/env.example` explains every setting.

## A5. Start

```bash
./deploy/production/hamnivo.sh up
```

The first run takes 10 to 20 minutes. It does the following:

1. **Builds the two images from this code:**
   - `hamnivo/gateway`: the API, the worker and database migrations;
   - `hamnivo/edge`: Caddy, with Studio, the widget and the website.
2. **Starts PostgreSQL** (with pgvector) and creates the database roles.
3. **Applies the database migrations.**
4. **Prepares Chatwoot's database and starts Chatwoot.**
5. **Starts the API, the worker, Valkey and ClamAV.**
6. **Gets certificates** for every name from Let's Encrypt.
7. **Creates the Chatwoot super admin and the Hamnivo Platform App.** It stores the app's token in
   `.env`.

When it finishes, it prints the addresses. Check the services at any time:

```bash
./deploy/production/hamnivo.sh status
./deploy/production/hamnivo.sh logs api worker     # follow the logs (Ctrl+C to stop)
```

## A6. First steps

Open Studio, the staff console, at `https://app.example.com` (your domain in place of
`example.com`).

1. **Create your account** with "Create an account". Confirm your email with the link Hamnivo sends
   you; it brings you back to Studio. Without SMTP, no email arrives: run
   `./deploy/production/hamnivo.sh mail you@example.com` on the server and open the link it shows.
2. **Create your workspace.** This is your company in Hamnivo.
3. **Turn on two-step verification** under Account security. Registering identity keys needs it,
   and publishing asks you to sign in again.
4. **Create a brand** under "Brands and install". Give it a name and list the websites that may show
   its chat, for example `https://www.yourshop.com`. No other website can show it. You can change the
   list later with "Edit". A website you take off the list stops showing the chat at once, and its
   open chats end.
5. **Connect Chatwoot** with the button on the brand. Before anything happens, Studio lists what it
   will set up: a Chatwoot account with an inbox for the website chat, an AI bot that answers there,
   and signed webhooks back to Hamnivo.
6. **Publish the AI agent** from "AI agents". It answers with the offline `hamnivo-mock` model
   until you add a model under "Model connections", choose it in the agent and publish again.
7. **Give the AI your knowledge** under Knowledge. Upload text, Markdown, HTML, PDF or Word files.
8. **Put the chat on your website.** Copy the install code from the brand's card into your pages,
   for example:

   ```html
   <script src="https://chat.example.com/loader.js" data-widget-id="wid_..."
           data-api="https://api.example.com" async></script>
   ```

Staff answer customers in Hamnivo Studio's **Inbox**. Go to `https://app.example.com` and click
**Inbox** to see waiting chats.

### Decisions with Jev

Jev is TypeSafe's decision model. It can route each conversation to the team that handles its topic.
It answers a fixed question, "which of these topics is this?", with a confidence for each answer.
Hamnivo acts on the answer only when that confidence reaches the threshold you set for the
conversation's language. Without Jev, a fixed keyword rule routes.

1. Put your key from typesafe.ai in `deploy/production/.env` as `TYPESAFE_API_KEY=...`, then run
   `./deploy/production/hamnivo.sh up --no-build`.
2. In Studio, open **Decision rules**, choose the brand, and edit its **Rubric**:
   - **Provider:** Jev. **Model:** a fixed version, currently `jev-1.13.0`. Moving names such as
     `jev-latest` are refused, so a new Jev release changes nothing until you try it and publish a
     rubric that names it.
   - **Topics:** the topics your teams handle, each with a few keywords for the fixed rule. Under
     **Teams**, say which team takes which topics.
   - Try a few messages under **Try a message**, then publish.
3. The brand starts in **shadow** mode. Every conversation records both Jev's choice and the fixed
   rule's, but only the fixed rule routes. **Jev compared with the fixed rules** shows how often
   they agree, per language.
4. Switch to **live** when the comparison looks right. Each language has a minimum confidence;
   below it, the fixed rule routes. Choosing Jev fills in the values Hamnivo measured for
   `jev-1.13.0` (0.50 in every language). In that test Jev chose the right topic for 260 of 266
   messages in the six languages; the keyword rule chose it for 188
   ([report](evals/jev-1.13.0-2026-10-02.md)). Those were test messages, not your customers', so
   look at each language on your own conversations before you rely on it there.

Rules that always hold:
- A customer who asks for a person gets one; Jev never decides that.
- If TypeSafe is slow or down, the fixed rule routes once the rubric's deadline passes (1.5 s by
  default).
- With the message guard on (see "Message guard" below), Hamnivo also reads customer messages in
  conversations your team handles, with personal data replaced by its kind, and sends them to
  TypeSafe. This reading runs in the worker after the message is saved, so it never delays
  delivery.
- Each decision sends TypeSafe only the customer's latest messages and the conversation's status, as
  the rubric chooses. In the test that was about 670 tokens, at $0.042 per million input tokens
  (TypeSafe's price in October 2026): about $0.00003 per decision. Half of the decisions took 148 ms
  or less, and 95% took 214 ms or less.
- TypeSafe says it does not train Jev on requests or responses
  ([data handling](https://docs.typesafe.ai/models)).

### Reply checks with Jev

Jev can also check AI replies. Open **Reply checks** in Studio and choose the brand. Each check
works like routing: choose Jev and a fixed version, set how sure Jev must be in each language,
publish, and start in **comparison only** mode, which records what Jev finds and changes nothing.
Switch a check to **live** when its records look right.

- **Answer check:** before an AI reply is sent, Jev checks each sentence that cites your knowledge
  against the passage it cites. When live, a reply with a sentence the passage does not support is
  written again once without it; if that fails too, a person takes over with a note.
- **Escalation advice:** before the AI answers, Jev checks whether the customer needs a person: a
  request it may have missed, a risk to health or safety, a legal threat, a complaint, or
  frustration with a problem that is still not solved. When live, a person takes over with the
  reason in the note. A customer who asks for a person always gets one, without Jev.
- **Passage relevance:** before the AI writes, Jev reads each passage found in your knowledge
  with the customer's question. When live, passages that are off topic, answer nothing, or try
  to give the assistant instructions are left out, and the record says which.
- **Reply language:** when a customer's words fit more than one language (often Hinglish and
  Roman Urdu), Jev picks one. When live, its choice is used if Jev is sure enough for that
  language; otherwise the customer is asked once, as before. Choosing Jev fills in the thresholds
  Hamnivo measured. A customer's own choice always wins.
- **Message guard:** Jev reads what comes in and what goes out. Someone who may be at risk gets
  safety wording and an urgent note to your team, whoever has the conversation (see "Message
  guard" below). A threat or abuse goes to a person while the AI has the conversation, and is
  only recorded where people have it. A draft reply that says or promises a payment, refund or
  order change without a receipt or a submitted refund is written again once, then passed to a
  person. The receipt check runs first and keeps the final say. These questions have no measured
  thresholds yet: set them from what comparison mode records.

If Jev is slow or unavailable, or a language has no threshold, the reply goes out as it would
without the check, and the check is recorded. A check sends TypeSafe only what it needs: the
customer's latest messages or the draft reply, with personal data replaced by its kind, and the
knowledge passages it checks.

### Message guard

The message guard is the one check that also reads conversations your team handles, so it has
rules of its own.

- **What it reads.** With the message guard on, in comparison mode or live, Hamnivo reads every
  customer message: while the AI answers, while the conversation waits for a person, and while a
  person handles it. It sends TypeSafe the customer's latest three messages up to that one, with
  personal data replaced by its kind, and nothing else about the conversation. That is in addition
  to what routing sends. The reading runs in the worker after the message is saved, so it never
  delays delivery to the customer or to your team. If TypeSafe is slow or down, nothing changes,
  and the check is recorded.
- **What happens when someone may be at risk:** the customer says they want to hurt themselves, or
  that someone is in danger now. In comparison mode only a record is made. Live, it depends on who
  has the conversation:
  - *The AI answers.* The customer gets safety wording at once, in their language, and a person
    takes over with an urgent note. A customer who asks for a person is handed over first, as
    ever, and the guard is asked after that. The same holds when the AI cannot answer: no
    published agent, an agent that only suggests, or a kill switch. The wording is fixed text,
    not something a model wrote, so a kill switch does not hold it back, and neither do the
    plan's limits or the AI budget.
  - *Nobody is assigned yet.* The conversation waits for a person: your team gets an urgent note
    and the customer gets the safety wording, both at once.
  - *A person is assigned.* The person gets the urgent note at once, with the wording in the
    customer's language so they can send it themselves. If nobody has replied to the customer
    after 2 minutes, Hamnivo sends it. It does not send it if the AI has the conversation again,
    or if anyone, staff or a bot, has replied to the customer since their message (private notes
    and activity do not count). A reply that lands in the moment between that check and the
    sending can still be followed by the wording.

  In a conversation people have, Hamnivo speaks only when nobody else is speaking: never over a
  person, and never while the AI has the conversation again. The wording for a conversation a
  person has says that the team was told and a person will reply, not that the chat was passed
  on. The urgent note is a private note: the customer never sees it. Records keep the reasons,
  never the message text.
- **Limits.** A conversation gets at most one automatic safety wording in 24 hours, on every path
  above. When that holds the wording back, the hand-off and the urgent note still happen, and the
  note says that no wording was sent because one was sent in the last 24 hours. Where people have
  the conversation, an urgent note goes out at most once in 10 minutes.
- **Thresholds.** Start with 0.5 for `self_harm` and `in_danger`: set both **yes from** and **no
  up to** to 0.5, so that no answer falls in between and is ignored. In a test of 15 messages,
  messages about risk scored 0.97 to 0.99, and everyday phrases such as "this bill is killing me"
  scored 0.14 or below. That is a small test, not your customers' words. Before you go live, look
  at the scores in your own comparison records (the records API returns each answer's score) and
  move the number if everyday messages come close to it.
- The safety wording in languages other than English is waiting for review by native speakers.

### Bring your old chats

Studio's **Import history** page brings a brand's conversations over from another tool. The
conversations land in Chatwoot, as if they had always been there.

**Sources:**
- a tawk.to export file;
- a Zendesk full JSON export;
- Intercom conversations in its API format;
- a Hamnivo package;
- another Chatwoot, read with an access token.

**Steps:**
1. Upload the export, or connect the other Chatwoot.
2. Read the check. It lists counts, how each field is imported, the source's known limits and the
   records to review.
3. Do a dry run. It writes nothing.
4. Start the import, then compare the sample conversations with your export.
5. Approve, or roll back.

**What keeps it safe:**
- Imports never message customers. Each brand gets its own import inbox without a webhook, bot,
  auto-assignment or automations. The check stops an import while anything there could notify
  people. Conversations keep their original times.
- Uploads are scanned for malware before they are read. Keep ClamAV running
  (`COMPOSE_PROFILES=scan`, the default). Without it, only the standard EICAR test file is caught.
- The other Chatwoot's token is stored encrypted, used once and then revoked in Hamnivo. Revoke it
  in that Chatwoot as well. Its address must be public `https`.
- Uploaded files are deleted at approval or rollback, or `MIGRATION_EXPORT_RETENTION_DAYS` after
  the import ends.

**Limits:**
- Teams and groups from the other tool are not imported.
- The Zendesk and Intercom readers follow those vendors' documented formats but have not yet been
  tried on real exports. Use the dry run and the samples before you approve.

### Your team

Under **Team and access**:

- **Members.** Invite people by email with a role and, if you like, a narrower scope (one
  workspace, team or brand). They join from the link in the email, signed in with that address.
  You can only hand out access you have yourself. Change someone's role in one step, suspend them
  or remove them. They lose access on their next request, and their live views close at the next
  check (15 seconds by default). Removing someone first shows what they still hold, such as open
  conversations.
- **Roles.** The built-in roles can't be changed. A custom role can only contain permissions you
  hold. Before it is saved, Studio shows what changes and who gains or loses what.
- **Audit log.** Every administrative change, with filters and an integrity check. Exporting it as
  CSV or NDJSON needs its own permission and a recent sign-in, and is recorded too. It never
  contains secrets or customers' messages.

### Single sign-on

An owner with two-step verification sets it up under **Security**:

1. **Prove the domain.** Add the company's email domain, publish the TXT record Studio shows
   (`_hamnivo-verification.example.com`), then check it. Once it is verified, no other workspace
   can use that domain.
2. **Connect the identity provider** (OpenID Connect): its issuer URL, and the client ID and
   client secret it gave you. The secret is stored encrypted and never shown again. Studio then
   shows the callback address; register it at the provider as a redirect URL.
3. **Turn it on**, and choose the role for people who sign in for the first time. Roles that need
   two-step verification can't be given this way. **Require single sign-on** turns away passwords
   and passkeys for addresses at the domain.

People then use "Continue with single sign-on" on the sign-in page. An existing account is joined
to the provider's identity only when both have verified the address. A provider on a private
network must be listed in `SSO_TRUSTED_IDP_ORIGINS` (comma-separated origins). Every other
provider must use HTTPS on a public address. `SSO_DNS_SERVERS` picks the DNS servers for the
domain check.

### Support access

The people who run the server never see a workspace's content on their own. When they need to,
they ask for read-only access with a reason, what they need to see and for how long. An owner
approves it, possibly narrower, or declines it under **Security**, and can end it at any time.
Every page shows a banner while it lasts, and both sides' audit logs record it.

### Settings that need the API for now

Three settings have no Studio screen yet: **business hours**, **identity keys** and **selling in
chat**. Set them through the API from any computer.

1. **Sign in with curl.**

   ```bash
   A=https://api.example.com; O=https://app.example.com
   curl -c jar -H "origin: $O" -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"your passphrase"}' $A/api/auth/sign-in/email
   # With two-step verification on, finish signing in with a code from your app:
   curl -c jar -b jar -H "origin: $O" -H 'content-type: application/json' \
     -d '{"code":"123456"}' $A/api/auth/two-factor/verify-totp
   curl -b jar -H "origin: $O" $A/v1/me        # your workspaces, with their ids (tnt_...)
   h=(-b jar -H "origin: $O" -H 'content-type: application/json' -H "x-hamnivo-tenant: tnt_...")
   ```

2. **Business hours.** With them set, the chat tells customers honestly when people are away and
   when they are back. The AI keeps answering at any hour.

   ```bash
   curl "${h[@]}" -X PUT $A/v1/admin/brands/brd_.../business-hours -d '{"businessHours":
     {"timezone":"Asia/Karachi","closedDates":[],"weekly":{"sun":[],"sat":[],
      "mon":[{"open":"09:00","close":"17:00"}],"tue":[{"open":"09:00","close":"17:00"}],
      "wed":[{"open":"09:00","close":"17:00"}],"thu":[{"open":"09:00","close":"17:00"}],
      "fri":[{"open":"09:00","close":"12:30"},{"open":"14:30","close":"17:00"}]}}}'
   ```

3. **Identity keys** let the widget recognize customers who signed in on your website. The
   [identity guide](guides/identity.md) covers the whole flow, with examples.
   - Register a key for the brand.
   - Your backend then signs a short-lived identity assertion for each signed-in customer.
   - The widget shows verified customers their own history.

   Registering a key needs two-step verification and a recent sign-in:

   ```bash
   curl "${h[@]}" -d '{"alg":"HS256"}' $A/v1/admin/brands/brd_.../identity-keys   # secret shown once
   ```

4. **Selling in chat (Stripe).** Customers then pick products, approve an exact quote in the
   chat, and pay on Stripe's own page. Orders, refunds and finance exceptions are in Studio.
   - Use a secret key (`sk_…`) or a restricted key (`rk_…`) with access to Products, Prices,
     Checkout Sessions, Payment Intents and Refunds. Hamnivo keeps it in its secret store and never
     shows it again.
   - Connecting needs two-step verification and a recent sign-in. Each brand has one connection.

   ```bash
   curl "${h[@]}" -d '{"brandId":"brd_...","provider":"stripe","displayName":"Noor Books",
     "currencies":["AED"],"apiKey":"rk_live_...","shipping":{"amountMinor":"1000","label":"Delivery"},
     "terms":{"refundSummary":"Refunds within 14 days of delivery."}}' $A/v1/admin/commerce/merchants
   ```

   The answer has a `webhookUrl`. In the Stripe Dashboard, add a webhook endpoint at that URL for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`,
   `payment_intent.requires_action`, `refund.created`, `refund.updated` and `refund.failed`. Then
   give Hamnivo the endpoint's signing secret:

   ```bash
   curl "${h[@]}" -X PATCH -d '{"webhookSecret":"whsec_..."}' $A/v1/admin/commerce/merchants/mrc_...
   ```

   Until the secret is set, Stripe's deliveries are refused and payments are confirmed by asking
   Stripe, which is slower. The catalog is the connection's active prices in its first currency;
   subscriptions are not sold in chat yet. By default every refund needs a second person to
   approve it (`refundPolicy`).

`curl "${h[@]}" $A/v1/admin/brands` lists your brands with their ids (`brd_...`). The interactive
API reference is at `https://api.example.com/docs`; set `API_DOCS=false` to hide it.

## A7. Everyday operations

| Task | Command |
|---|---|
| See services and health | `./deploy/production/hamnivo.sh status` |
| Check the whole server, and see how to fix what is wrong (HTTPS certificates, ports, disk, memory, deploys) | `./deploy/production/hamnivo.sh doctor` |
| Follow logs | `./deploy/production/hamnivo.sh logs [service…]` |
| Back up now | `./deploy/production/hamnivo.sh backup` |
| Back up every night and check a backup every month | `./deploy/production/hamnivo.sh backups on` |
| Check that a backup restores, without touching live data | `./deploy/production/hamnivo.sh backup-check [deploy/production/backups/<time>]` |
| Restore a backup | `./deploy/production/hamnivo.sh restore deploy/production/backups/<time>` |
| Deploy the latest code now (checks, build, health, rollback) | `./deploy/production/hamnivo.sh update` |
| Deploy history, or go back one version | `./deploy/production/hamnivo.sh deploys`, `… rollback` |
| Apply changed settings | `./deploy/production/hamnivo.sh up` |
| Stop everything | `./deploy/production/hamnivo.sh down` (data stays in Docker volumes) |
| Any compose command | `./deploy/production/hamnivo.sh compose <command>` |
| Name a platform operator, or disable one | see "The platform console" below |

### The platform console

The platform console (`https://app.example.com/platform`) is for the people who run this server. It
shows workspaces (never their content), service health, support access and AI stops, and posts
incident banners that every workspace sees. Nobody gets it from a workspace role: you name
operators on the server, after they have created their account in Studio:

```bash
./deploy/production/hamnivo.sh compose run --rm --no-deps migrate \
  node dist/main.operator.js you@example.com platform_admin
# or support_operator, platform_viewer; --disable instead of a role takes it away
```

Operators need two-step verification for anything beyond looking. Every action is recorded in the
platform's own audit log. In development, use
`pnpm --filter @hamnivo/db platform:operator <email> <role>`.

### Plans and invoices

Hamnivo's operator, not the workspaces, defines plans, assigns them and issues invoices, with the
billing command. Each step is recorded in the workspace's audit log under the name in
`HAMNIVO_OPERATOR`. A workspace without a plan has no limits.

New workspaces start on the built-in **free** plan, which has limits (100 conversations and 200 AI
replies a month, 2 seats, among others). If you host Hamnivo only for yourself, set
`HAMNIVO_DEFAULT_PLAN=unlimited` in `.env` before creating workspaces: they then get no plan and
nothing is limited. Workspaces created before keep the plan they have; `plan:assign` changes it.
To sell Hamnivo to other businesses (sign-up, trials, Stripe or WHMCS), see
[docs/guide/saas](guide/saas/run-as-saas.md).

A plan is a JSON file. Prices are in minor units (cents), written as strings. `limits` can hold
`conversations`, `aiReplies` and `aiTokens` (per calendar month, UTC) and `knowledgeStorageBytes`,
`seats` and `webhookEndpoints` (at any time); a limit left out is unlimited. `metered` prices usage
beyond what the plan includes. `trialDays` (optional) lets a workspace try the plan first, and
`stripePriceId` (optional) is the Stripe price that sells it.

```json
{"key":"starter","name":"Starter","currency":"USD","priceMinor":"4900",
 "limits":{"conversations":1000,"aiReplies":5000,"aiTokens":2000000,
           "knowledgeStorageBytes":104857600,"seats":5,"webhookEndpoints":3},
 "metered":[{"limit":"conversations","includedUnits":1000,"unitPriceMinor":"5","perUnits":1}]}
```

```bash
b=(./deploy/production/hamnivo.sh compose exec -T -e HAMNIVO_OPERATOR=you@example.com \
   api node dist/main.billing.js)
"${b[@]}" plan:set - < starter.json         # create or change a plan
"${b[@]}" plans                             # list them
"${b[@]}" plan:assign acme starter          # a workspace, by slug or tnt_… id
"${b[@]}" plan:assign acme starter --trial  # the same, starting the plan's trial days
"${b[@]}" invoices:generate 2026-09         # drafts for a finished month
"${b[@]}" invoice:issue HV-202609-0E4F2A1B  # the workspace sees it from now on
"${b[@]}" invoice:paid HV-202609-0E4F2A1B bank-transfer-0042
"${b[@]}" invoice:failed HV-202609-0E4F2A1B "card declined" 2026-10-20
"${b[@]}" invoice:void HV-202609-0E4F2A1B "issued by mistake"
```

At a limit, Hamnivo refuses what would go past it with `402 PLAN_LIMIT_REACHED` and the numbers
(a new conversation is refused without telling the customer about the plan). When the AI replies,
tokens or a workspace's own AI budget run out, new conversations go to people instead. Studio shows
usage against the limits under **Reports → Billing** and **Settings → Plan and billing**. Invoices
are drafted from the plan price and the metered usage of the month and collected by hand
(`invoice:paid`). Workspaces that pay through Stripe or WHMCS are billed there and get no invoice
from Hamnivo. In development, run the same commands with
`pnpm --filter @hamnivo/gateway billing <command>` after building the gateway.

### Backups

A backup is a folder under `deploy/production/backups/` named after the time (UTC). It holds:

- both databases (`pg_dump`);
- Chatwoot's uploaded files;
- the certificates;
- a copy of `.env`;
- checksums of every file.

The newest 14 backups are kept (`--keep N` changes that). `--no-secrets` leaves out `.env`, if you
store it separately. Backups contain personal data and secrets: encrypt them and copy them off the
server, for example with [restic](https://restic.net).

Back up every night, and check every month that the newest backup restores:

```bash
./deploy/production/hamnivo.sh backups on
```

This installs two systemd timers. Every night at about 03:00 in the server's time zone (UTC on most
servers) a backup is made; a night the server was off is made up when it starts. On the first of
each month, `hamnivo.sh backup-check` restores the newest backup into throwaway databases beside the
live ones, checks what came back (the migrations, the workspaces, Chatwoot's accounts), and drops
them. The live data and the running applications are never touched; the check needs free disk for
one more copy of the databases while it runs. Run it by hand on any backup:

```bash
./deploy/production/hamnivo.sh backup-check deploy/production/backups/20260927T031500Z
```

`hamnivo.sh backups status` shows the timers, how their last runs ended and the newest backup;
`journalctl -u hamnivo-backup` shows a run's log. `backups off` removes the timers and keeps the
backups. Without systemd, run `hamnivo.sh backup` from cron every night instead.

The two databases are dumped one after the other, a few seconds apart. Messages written in those
seconds can be missing from one of them.

### Restore

```bash
./deploy/production/hamnivo.sh restore deploy/production/backups/20260927T031500Z
```

A restore:

1. checks the checksums;
2. stops the applications;
3. saves customers' memory consent, memory deletions and erasures from the current database;
4. restores the Hamnivo database beside the current one and runs pending migrations, so a backup
   from an older version works with newer code;
5. adds the consent, deletions and erasures saved in step 3, and deletes again any memory and
   customers they cover;
6. only then replaces the current database, so a restore that fails leaves it as it was;
7. replaces the Chatwoot database and the files, and starts everything again.

Customers' privacy choices are the one thing a restore does not take back. Someone who withdrew
consent, had their memory deleted or was erased after the backup keeps that choice: the memory stays
deleted, and an erased customer the backup brings back is erased again, in Hamnivo and in Chatwoot.
Deletions, exports and erasures that were still running finish once the worker starts.

It refuses a backup made with other secrets, unless you move your `.env` away first. While it
runs, it needs free disk space for a second copy of the Hamnivo database. If it fails before step 6,
nothing was replaced, and it starts the applications again. If the current database cannot be
read, it stops at step 3; `--ignore-current-database` restores without the consent and deletions
described above.

On a new server, clone the code (A3), copy the backup folder over and run the same command. It
installs the backup's `.env` and builds what it needs. A new server has no current database, so
consent and deletions made after the backup are lost with the old server. To move servers, take a
fresh backup on the old one just before.

The monthly check proves a backup restores, but not the whole procedure: test a full restore now
and then on a spare server. `scripts/ci/production-smoke.sh` runs a backup, its check, and a restore
drill in its checks.

### Retention and backups

A workspace can choose how long resolved conversations are kept (Studio, **Settings** → **Privacy**;
[guide](guide/setup/privacy.md)). The worker then deletes old conversations in Chatwoot and in
Hamnivo, about 150 per workspace an hour (`RETENTION_BATCH`, `RETENTION_PER_WORKSPACE`). Chatwoot
removes the files of a deleted conversation in its background jobs, a little later.

Deleted conversations stay in backups until those are rotated out (the newest 14 are kept). A
restore brings them back, and the worker deletes them again on its next run, as long as the
workspace still keeps conversations for less time than their age. Handled outbox events, some of
which carry message text, are deleted after 30 days.

### Updates

```bash
./deploy/production/hamnivo.sh update
```

This deploys the newest commit of `main` (the branch in `HAMNIVO_DEPLOY_BRANCH`), the way automatic
deploys do (A10):

1. **Checks** that HTTPS works on this server now, then a clean copy of the new version: Biome, type
   checks and unit tests. A failure stops here and touches nothing that runs. If the version that
   runs has no HTTPS certificate (browsers show an SSL error), it stops before building, because a
   new version could not be switched in either: it says which name has no certificate and points
   to `hamnivo.sh doctor` (A9). Other failures of the running version do not stop it, because the
   new version may be the fix. `hamnivo.sh deploy --force` skips that first check.
2. **Builds** its images, tagged with the commit.
3. **Backs up** first when the new version changes the database or its containers, into
   `backups/before-deploy/`.
4. **Switches:** the checkout moves to the new version, `.env` gets its new settings, database
   migrations run, and the new version starts. It must answer over HTTPS, then stay healthy for 45
   seconds. If a name has no certificate at that point, the web server restarts once and is
   checked again.
5. **Rolls back** if it does not: the settings and the version that ran before come back. The log,
   `hamnivo.sh deploys` and GitHub say why, for example "no HTTPS certificate for
   api.example.com (run hamnivo.sh doctor)".

While the API restarts, requests wait a few seconds for it, and open chats reconnect by
themselves. `hamnivo.sh deploys` lists every deploy; `hamnivo.sh rollback` goes back to the
version before.

The first update from a version older than this one still runs the old procedure (backup, pull,
rebuild, restart). Every later update runs the one above. If you ran `git pull` yourself first,
`update` still deploys the new version: older images do not say which commit they run, so it backs
up and deploys.

## A8. Security checklist

- Only ports 80 and 443 are open (A2), and SSH uses keys, not passwords.
- `deploy/production/.env` is private (mode 600) and backed up securely.
- Backups are encrypted and stored off the server.
- `REQUIRE_EMAIL_VERIFICATION` stays `true`, and SMTP is configured.
- Each brand lists only its real websites in `allowedOrigins`.
- `CHATWOOT_ALLOW_PRIVATE_WEBHOOKS` stays `false`, so Chatwoot cannot call private addresses.
- The operating system updates itself (`sudo apt-get install unattended-upgrades`). Hamnivo
  deploys itself from GitHub (A10), or you run `hamnivo.sh update`.
- With automatic deploys:
  - `main` is protected on GitHub (pull requests only, no force pushes);
  - the deploy key is read-only;
  - the GitHub token, if you added one, is fine-grained, for this repository only, with
    "Deployments" access only.
- To collect metrics, set `METRICS_TOKEN` and scrape `https://api.example.com/metrics` with it.
- To track errors, set `SENTRY_DSN` to a project's DSN on Sentry or on your own GlitchTip, then
  `hamnivo.sh up`. Errors from the API, the worker, Studio and the chat arrive there, tagged
  `gateway-api`, `gateway-worker`, `studio` and `widget`. No user details, cookies, headers,
  bodies, query strings or chat text are sent. The browsers send through the API, so the CSP
  needs no change. To check it:
  - the gateway: `docker compose exec api node dist/main.error-test.js`;
  - Studio or the chat: in the browser console of either, run
    `setTimeout(() => { throw new Error('Hamnivo test error') })`.
- Behind Cloudflare's proxy, `HAMNIVO_CLOUDFLARE=on` (A4). Without it, every visitor has
  Cloudflare's address, so rate limits apply to many visitors at once.

## A9. Troubleshooting

- **No certificate / browser warning:**
  - Check that every name resolves to the server (`dig +short api.example.com`).
  - Check that ports 80 and 443 are open.
  - Read `hamnivo.sh logs edge`.
  - Let's Encrypt limits failed attempts, so fix DNS first, then run `hamnivo.sh up`.
  - A browser error such as `ERR_SSL_PROTOCOL_ERROR` has its own entry below.
- **The browser shows an SSL error, or every deploy rolls back:** the web server (Caddy) has no
  certificate for a name. Browsers say `SSL_ERROR_INTERNAL_ERROR_ALERT` or
  `ERR_SSL_PROTOCOL_ERROR`, plain `http://` still redirects, and `hamnivo.sh deploys` says "no HTTPS
  certificate for api.example.com" or "HTTPS is not working on this server".
  1. Run `hamnivo.sh doctor` on the server. It tries every public name over HTTPS, shows the last
     lines Caddy logged about certificates, and prints a fix and its exact command under each ✗.
  2. Fix it in this order:
     1. Restart the web server, so that Caddy asks for the certificates again:
        `hamnivo.sh compose restart edge`.
     2. If Caddy's log mentions a rate limit (`rateLimited`), wait. Let's Encrypt allows only a few
        attempts per name; the log names the time it allows the next one, which is between an hour
        and a week away. Then restart the web server again.
     3. Check DNS and the ports. Every name must resolve to this server
        (`dig +short app.example.com`), and ports 80 and 443 must be open to the internet, because
        Let's Encrypt calls them (A2).
  3. Never free disk space with `docker volume prune` or `docker system prune --volumes`. Docker
     counts the volumes of a stack that is down as unused, so they delete the databases and the
     certificates, and Caddy then asks Let's Encrypt for new certificates and may hit the limit.
     `docker builder prune -af` frees the build cache and nothing else.
  4. Once HTTPS works, automatic deploys carry on by themselves: one that stopped for this reason is
     tried again every 30 minutes, without a new commit.
- **Studio says "We couldn't reach Hamnivo" behind another web server:** the addresses carry the
  edge's own port (`hamnivo.sh doctor` shows them under "Addresses"). Run `setup --public-port 443`,
  then `hamnivo.sh up`, which builds Studio again with the new addresses.
- **The first start is slow:** Chatwoot prepares its database (2 to 3 minutes), and ClamAV
  downloads its virus signatures (a few minutes). Uploads wait for ClamAV and are scanned when it
  is ready.
- **The chat does not open on a website:** the website's exact origin (scheme, name and port) must
  be in the brand's `allowedOrigins`.
- **No emails:** set `SMTP_URL` and run `hamnivo.sh up --no-build`, then send the email again. Until
  then, `hamnivo.sh mail` shows the emails and their links. With `SMTP_URL` set, failures to send
  are in `hamnivo.sh logs api`.
- **Out of memory:** remove `scan` from `COMPOSE_PROFILES` and empty `CLAMAV_URL` to run without
  ClamAV (customers then cannot send files in the chat), or add memory.
- **Building behind a proxy that inspects TLS:** set `HAMNIVO_BUILD_CA=/path/to/proxy-ca.pem`
  before `hamnivo.sh up`.
- **Cloudflare:**
  - "Too many redirects": set SSL/TLS to **Full (strict)**.
  - Error 525 or 526, or no certificate: turn **Always Use HTTPS** off, or set the names to DNS
    only until `hamnivo.sh up` has its certificates.
  - Every visitor has the same address in logs: run `setup --cloudflare on` (A4), then `up`.
- **A push was not deployed:**
  - `hamnivo.sh autodeploy status` shows the mode, the git access and the last deploys.
  - `journalctl -u hamnivo-deploy` shows each run.
  - On GitHub, **Settings → Webhooks → Recent Deliveries** shows GitHub's calls:
    - `200`: the server checks for a new commit. Pushes to other branches get `200` too, and
      deploy nothing.
    - `403`: another repository or another event than push.
    - `500`: a wrong secret.
  - The 5-minute check deploys even when a webhook is lost.
  - A commit that failed is not retried, except once after 30 minutes when it stopped before the
    switch (for example, a download failed during the build). Push a fix, or run
    `hamnivo.sh deploy --force <commit>`. A commit that stopped because HTTPS does not work on the
    server is not a failed commit: it is tried again every 30 minutes until HTTPS works.
  - `hamnivo.sh doctor` shows the git access, how many commits the checkout is behind, and the last
    three deploys with their reasons, together with everything else that can go wrong.
  - `hamnivo.sh deploys` lists versions that wait for a deploy by hand (A10).
- **A deploy stopped or rolled back:** its full log is in `deploy/production/state/logs/`, and
  `hamnivo.sh deploys` names the step.
  - "local changes on the server": files tracked by git were edited on the server. Commit such
    changes to the repository instead.
  - "HTTPS is not working on this server: no certificate for NAME": the deploy stopped before
    building, because HTTPS was already broken. Fix it first (the entry above, `hamnivo.sh doctor`).
  - "no HTTPS certificate for NAME" after "rolled back": the new version started, but Caddy had no
    certificate for that name, even after one restart of the web server. Same entry.
  - "not enough disk space": free space for Docker, or lower `HAMNIVO_DEPLOY_BUILD_CACHE_GB`. Remove
    the build cache with `docker builder prune -af`, never with `docker volume prune`.
  - "stopped at guards": a migration that already ran was edited or removed, or a new one is dated
    before the newest applied one. Add or regenerate the migration in a new commit.
- **After restoring a backup on a new server:** run `hamnivo.sh autodeploy enable` there too. The
  restore builds the images when the backup's version is not on the server.

## A10. Automatic deployment from GitHub

With this on, every push to `main` goes live on your server within minutes, without GitHub
Actions:

```
push to main ─► GitHub webhook (signed) ─► https://api.example.com/_deploy/github ─► Caddy
  ─► deploy-hook (checks the signature, the branch and the repository) ─► systemd on the server
  ─► hamnivo.sh deploy --latest
```

A timer also looks for new commits every 5 minutes, because GitHub never sends a failed webhook
again.

Each deploy runs like `hamnivo.sh update` (A7). The checks and the build run on a clean copy of the
new version while the running one keeps serving. The new version must then become healthy and stay
healthy for a short while; otherwise the one before starts again. Specific to automatic deploys:
- A commit that failed is not tried again automatically; the next commit is. One exception: a
  deploy that stopped before the switch (for example, a download failed during the build) is tried
  once more after 30 minutes.
- Before building, a deploy checks that HTTPS answers on this server (the API, Studio and the chat
  loader). If no certificate is served for a name, it stops with "HTTPS is not working on this
  server" instead of building a version that would be rolled back. That stop never counts as a
  failed commit: it is tried again every 30 minutes, so a fix of the certificates (A9) is enough,
  without a new commit. Other failures of the running version do not stop a deploy, because the new
  version may be the fix.
- After the switch, a name without a certificate restarts the web server once and is checked again,
  before the deploy is rolled back.
- Some versions wait for you, because starting the previous version could not undo them:
  - a migration that drops, renames or changes the type of data;
  - a new version of other software in `compose.yml` (Chatwoot, PostgreSQL, Valkey). Chatwoot,
    for example, migrates its database when it starts.

  `hamnivo.sh deploys` lists them. Deploy one with `hamnivo.sh deploy <commit>` when you are
  ready; it backs up first.
- With a GitHub token, each deploy appears on GitHub under **Environments → production**.

### Turn it on

1. **On the server:**

   ```bash
   ./deploy/production/hamnivo.sh autodeploy enable
   ```

   It needs `sudo` once, to install three systemd units. It:
   - checks that the server can read the repository, and creates a read-only deploy key if needed
     (A3);
   - generates the webhook secret;
   - starts the webhook receiver and turns on its route;
   - prints what to enter on GitHub.
2. **On GitHub,** in the repository's Settings:
   - **Webhooks → Add webhook.** Enter the payload URL and the secret it printed. Choose content
     type `application/json` and "Just the push event". GitHub sends a ping at once, and Recent
     Deliveries should show `200`.
   - **Branches.** Protect `main`: require a pull request and block force pushes, because whatever
     reaches `main` goes live.
3. **Optional: deployment statuses on GitHub.**
   1. Create a fine-grained personal access token under **Settings → Developer settings →
      Fine-grained tokens**. Limit it to this repository, with the permission **Deployments: Read
      and write**.
   2. Save it in a file and run `hamnivo.sh autodeploy enable --github-token-file <file>`.
   3. Delete the file.

GitHub sends webhooks only to a certificate it trusts, such as Let's Encrypt's (the default). Without
one (`--tls internal`), or without a public address (for example behind NAT), run
`hamnivo.sh autodeploy enable --mode poll`. The server then checks every 5 minutes.

Run `autodeploy enable` as the user who owns the checkout, without `sudo`: deploys run as that user.

### Watch, pause, go back

| Task | Command |
|---|---|
| Mode, git access and recent deploys | `hamnivo.sh autodeploy status` |
| Check the whole server when deploys fail or roll back: HTTPS certificates, ports, disk, memory, systemd units, git, the last three deploys | `hamnivo.sh doctor` |
| Deploy history | `hamnivo.sh deploys` |
| Follow a deploy | `journalctl -u hamnivo-deploy -f` |
| One deploy's full log | `ls deploy/production/state/logs/` |
| Pause automatic deploys | `hamnivo.sh autodeploy pause` (and `resume`) |
| Go back to the version before | `hamnivo.sh rollback` |
| Deploy a given commit or tag | `hamnivo.sh deploy <commit>` |
| Deploy even though the commit failed before, or HTTPS is broken | `hamnivo.sh deploy --force <commit>` |
| Turn it off | `hamnivo.sh autodeploy disable` |

After a `rollback`, the version you left is not redeployed automatically; the next new commit is.

### Keep migrations reversible for one release

A rollback starts the older code on the newer database. Change the schema in two steps:
1. **Add first:** new tables, and new columns that may be empty.
2. **Remove later:** drop old columns only in a later release, once nothing uses them.

Deploys check what they can:
- **Stopped:** a migration that already ran was edited or removed, or a new one is dated before the
  newest applied one. The database would skip it for good. Add or regenerate the migration in a new
  commit. The unit tests also check that migrations are dated in order.
- **Waits for you:** a migration that drops, renames or changes the type of data.
- **Backed up first:** a release that changes the database, its containers (`compose.yml`) or
  `deploy/postgres/`. The backup goes to `deploy/production/backups/before-deploy/`, where the
  newest 5 are kept.

### Resources

The checks and builds run on the server, next to the live services. With Docker's build cache they
usually take a few minutes, because only changed packages are rebuilt and tested.

They build 2 packages at a time, which takes about 3 GB of memory besides the running services. On a
server with 8 GB, add swap (A2) or set `HAMNIVO_BUILD_CONCURRENCY=1`.

These settings go in `.env` (see `env.example`):

| Setting | Default | Meaning |
|---|---|---|
| `HAMNIVO_BUILD_CONCURRENCY` | 2 | Packages built and tested at once; each package's unit tests get that share of the CPUs |
| `HAMNIVO_DEPLOY_BUILD_CACHE_GB` | 8 | Maximum size of Docker's build cache |
| `HAMNIVO_DEPLOY_KEEP` | 3 | How many versions' images are kept |
| `HAMNIVO_DEPLOY_MIN_FREE_GB` | 8 | Free space a deploy needs |
| `HAMNIVO_DEPLOY_HEALTH_SECONDS` | 600 | How long a new version may take to become healthy |
| `HAMNIVO_DEPLOY_SOAK_SECONDS` | 45 | How long it must then stay healthy |

During a switch, requests to the API wait for it (up to 30 s), and open chats reconnect by
themselves. The website and the widget pause for about 3 seconds while the web server restarts.

# Part B: Develop and run the checks

## 1. Server requirements

- **OS:** Ubuntu 24.04 LTS or any recent Linux with Docker. macOS works for development.
- **Checks and development:** 2 vCPU, 6 GB RAM, 25 GB free disk. The Chatwoot stage of the checks
  starts a complete Chatwoot (web, background jobs, database) for a few minutes.
- **Production:** see A1.

## 2. One-time setup

```bash
# Docker Engine and the compose plugin (official guide: https://docs.docker.com/engine/install/ubuntu/)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # log out and back in afterwards

# Node.js 24 LTS and pnpm 10
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs openssl git
sudo npm install -g pnpm@10.33.0

# The code
git clone https://github.com/CodeWithJuber/Hamnivo.git
cd Hamnivo
git checkout claude/hamnivo-app-implementation-bhb7rg   # until the work is merged to main
pnpm install

# Browsers for the accessibility audit and the widget journey (Chromium and WebKit, with their
# system libraries)
pnpm --filter @hamnivo/ui exec playwright install --with-deps chromium webkit
```

## 3. Configuration and secrets

```bash
bash scripts/setup/env.sh
```

This creates `.env.local` with generated database passwords, the secret-encryption key and the
auth secret. The script never overwrites existing values, so re-running it after an update is
safe. `.env.local` is gitignored and must never be committed or shared. Back it up somewhere
safe: without it, stored secrets cannot be decrypted.

## 4. Start the infrastructure

```bash
pnpm services:up      # PostgreSQL 18 + pgvector and Valkey, bound to 127.0.0.1 only
pnpm services:down    # stop; data stays in Docker volumes
```

The database creates four roles:

| Role | Purpose |
|---|---|
| `hamnivo_owner` | Runs migrations |
| `hamnivo_app` | Used by the application. It cannot bypass row-level security and owns nothing. |
| `hamnivo_platform` | Platform-console metadata only |
| `hamnivo_resolver` | Owns the few audited cross-tenant functions. It cannot log in. |

To reach the services from another machine, set `HAMNIVO_DB_BIND=0.0.0.0` in `.env.local` and
restrict access with a firewall. For the application alone, keep the default.

### Apply the database schema

```bash
pnpm db:migrate       # idempotent: applies only pending migrations, all-or-nothing
```

Every table has row-level security enabled and forced. The application role only sees the tenant
bound to its current transaction. See `packages/db/README.md` for the details.

### Run the API and the worker

```bash
pnpm api       # builds and starts the gateway on http://localhost:4000 (reads .env.local)
pnpm worker    # outbox relay and scheduled maintenance, in a second terminal
```

- Interactive API reference: `http://localhost:4000/docs`.
- OpenAPI document: `http://localhost:4000/v1/openapi.json`.
- Health checks: `/health/live` and `/health/ready` (database and Valkey).
- Without `SMTP_URL`, verification and invitation emails are printed to the API log, so you can
  open the links directly. On a server, set `SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`).

### Start Chatwoot

Chatwoot CE v4.18.0 owns conversations, messages and private notes. Hamnivo talks to it through its
APIs and signed webhooks (ADR 0001).

```bash
pnpm chatwoot:up      # first run about 2 minutes; http://127.0.0.1:3000
pnpm chatwoot:down    # stop; data stays in Docker volumes (add --volumes to delete it)
```

What `chatwoot:up` does:

1. It starts Chatwoot's own PostgreSQL 16 (with pgvector) and Valkey.
2. It creates or migrates the Chatwoot schema.
3. It starts the web and background-job processes.
4. It creates a super admin and the "Hamnivo" Platform App.
5. It writes the Platform App token to `.env.local` as `CHATWOOT_PLATFORM_TOKEN`.

The super admin email and password are in `.env.local` (`CHATWOOT_ADMIN_*`). Keep the Platform
token secret. Anyone holding it can create accounts and users.

Check the connector against your Chatwoot at any time:

```bash
set -a; . ./.env.local; set +a
pnpm --filter @hamnivo/chatwoot test:int
```

This runs the same contract suite the checks use. Each run creates a small test account in the
Chatwoot you point it at. Chatwoot delivers webhooks to `host.docker.internal`, which is this
machine. For that reason the development stack allows webhooks to private addresses
(`CHATWOOT_ALLOW_PRIVATE_WEBHOOKS=true`). In production the gateway has a public HTTPS address, so
set it to `false` and keep Chatwoot's SSRF protection on.

First steps with the API, before the Studio exists:

```bash
curl -c jar -H 'origin: http://localhost:5173' -H 'content-type: application/json' \
  -d '{"name":"Your Name","email":"you@example.com","password":"a long passphrase here"}' \
  http://localhost:4000/api/auth/sign-up/email
# open the verification link printed in the API log, then:
curl -b jar -c jar -H 'origin: http://localhost:5173' -H 'content-type: application/json' \
  -d '{"name":"My Company","slug":"my-company"}' http://localhost:4000/v1/tenants
```

### Connect a brand to Chatwoot and chat through the API

This needs `pnpm chatwoot:up` (it writes `CHATWOOT_URL` and `CHATWOOT_PLATFORM_TOKEN` to
`.env.local`), plus `pnpm api` and `pnpm worker` running. `CHATWOOT_WEBHOOK_BASE_URL` (default
`http://host.docker.internal:4000`) is how Chatwoot's webhooks reach the gateway.
`CHATWOOT_PUBLIC_URL` is Chatwoot's public address, shown to owners as the WhatsApp callback URL
for Meta (production sets it to `HAMNIVO_SUPPORT_ORIGIN`; it defaults to `CHATWOOT_URL`). Meta and
Telegram must be able to reach it over HTTPS.

1. Use the tenant ID (`tnt_…`) returned above. Find the workspace, then create a brand with the
   websites allowed to embed its chat:

   ```bash
   T=tnt_...   # your tenant id
   h=(-b jar -H 'origin: http://localhost:5173' -H 'content-type: application/json' -H "x-hamnivo-tenant: $T")
   curl "${h[@]}" http://localhost:4000/v1/admin/workspaces
   curl "${h[@]}" -d '{"workspaceId":"wsp_...","name":"My Shop","allowedOrigins":["http://localhost:8080"]}' \
     http://localhost:4000/v1/admin/brands
   ```

2. Connect the brand. This provisions a Chatwoot account with an HMAC inbox, the AI bot and signed
   webhooks, and stores every credential encrypted:

   ```bash
   curl "${h[@]}" -d '{"brandId":"brd_..."}' http://localhost:4000/v1/admin/authority/connections
   ```

3. Publish the brand's AI agent. Connecting created it as a draft that uses the offline
   `hamnivo-mock` model, and until it is published, people answer every conversation:

   ```bash
   curl "${h[@]}" http://localhost:4000/v1/admin/agents          # note the agent id (agt_…)
   curl "${h[@]}" -d '{}' http://localhost:4000/v1/admin/agents/agt_.../publish
   ```

   To use a real model, save a new draft with a different `model`, then publish again. For example,
   use `{"provider":"anthropic","modelId":"…"}` with `ANTHROPIC_API_KEY` in `.env.local`, or store
   a tenant key first with `POST /v1/admin/model-connections` and reference its `connectionId`.
   Publishing checks that the model has credentials. Every published version stays unchanged, and
   publishing an older version (`{"version":1}`) is the rollback.

4. Chat as a website visitor would. Use the brand's `widgetId`:

   ```bash
   S=$(curl -s -H 'content-type: application/json' \
     -d '{"widgetId":"wid_...","hostOrigin":"http://localhost:8080"}' http://localhost:4000/v1/widget/sessions)
   A=$(echo "$S" | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
   curl -H "authorization: Bearer $A" -H 'content-type: application/json' \
     -d '{"firstMessage":"Assalamu alaikum, where is my order?"}' http://localhost:4000/v1/widget/conversations
   curl -N -H "authorization: Bearer $A" -H 'last-event-id: 0' \
     http://localhost:4000/v1/widget/conversations/conv_.../events
   ```

The stream shows your message and, a moment later, the AI assistant's reply. With the default
agent, the reply comes from the offline `hamnivo-mock` model. The same conversation appears in
Chatwoot (`http://127.0.0.1:3000`), where your staff can also answer. A person replying or taking
over there takes the conversation from the AI.

Each AI reply is recorded as a run: agent version, model, tokens, time and outcome, but no message
text (`GET /v1/admin/runs`). To stop the AI at once, for the whole tenant, one brand or one agent:

```bash
curl "${h[@]}" -d '{"scope":"brand","targetId":"brd_...","reason":"Checking answers"}' \
  http://localhost:4000/v1/admin/kill-switches
```

Conversations the AI held go to people with an internal note, and people keep chatting as usual.
Clearing the switch (`POST /v1/admin/kill-switches/ksw_.../clear`) lets the AI answer again.

### Give the AI your knowledge

1. **Create a source.** Only `public` sources ground answers to customers. An `internal` source is
   for staff and for assist mode.

   ```bash
   curl "${h[@]}" -d '{"brandId":"brd_...","name":"Help centre","reviewEveryDays":90}' \
     http://localhost:4000/v1/admin/knowledge/sources
   ```

2. **Add documents.** Send text for plain text, Markdown or HTML, or `base64` for PDF and Word
   files. Each document can be up to 5 MB.

   ```bash
   curl "${h[@]}" -d '{"title":"Returns","url":"https://shop.example/returns","content":
     {"mediaType":"text/markdown","text":"# Returns\n\nYou can return unworn items within 30 days."}}' \
     http://localhost:4000/v1/admin/knowledge/sources/ksrc_.../documents
   ```

   The worker processes each document in order:
   1. It scans the upload. Malware, or a failure to scan, means refusal.
   2. It checks the file really is the declared type.
   3. It extracts the text, splits it into passages under their headings, and indexes them for
      keyword and vector search.

   A new version of a document replaces the old one only when it is ready.

3. **Connect the knowledge to the agent.** Put the source IDs in the agent's `knowledgeSourceIds`,
   save a draft and publish it. Answers then:
   - cite passages as `[1]`;
   - list the sources under the message in the chat;
   - drop any citation that matches nothing retrieved.

   Documents stop grounding answers when they are retired, past `validUntil`, or not reviewed
   within their source's cycle (`POST /v1/admin/knowledge/documents/doc_.../review`).

To preview what an answer would use, send `POST /v1/admin/knowledge/search` with
`{"query":"…","brandId":"brd_…"}`.

On a server, run ClamAV and set `CLAMAV_URL=tcp://clamav:3310`. Without it, knowledge uploads are
checked only for the EICAR test file, and the chat offers customers no files at all: customer
files are accepted only when ClamAV can scan them. `EMBEDDING_PROVIDER` selects the embedding model; the default offline
`mock` matches shared words only, so use a real provider for meaning-based search.

### Put the chat on a web page

The widget is a static app, and the loader is one small script served next to it.

1. Build them and serve them from one origin:

   ```bash
   pnpm build
   cp packages/widget-loader/dist/loader.js apps/widget/dist/
   pnpm --filter @hamnivo/widget preview    # serves apps/widget/dist on http://localhost:5174
   ```

2. `PUBLIC_WIDGET_ORIGIN` in `.env.local` must be the origin the widget is served from
   (`http://localhost:5174` here). The gateway allows cross-origin widget calls only from that
   origin, so restart `pnpm api` after changing it.

3. Add the loader to any page on a website in the brand's `allowedOrigins`
   (`http://localhost:8080` in the example above):

   ```html
   <script src="http://localhost:5174/loader.js" data-widget-id="wid_..."
           data-api="http://localhost:4000" async></script>
   ```

   For example, save that line as `index.html` in an empty folder and run
   `python3 -m http.server 8080` there.

Open the page and click the chat button. The widget opens, and you can send a message, get the AI
reply, ask for a person, and watch a staff reply from Chatwoot arrive live. Add
`data-locale="ur"` or `"ar"` for right to left. The loader options and the JavaScript API are
in `packages/widget-loader/README.md`. To build your own chat UI instead, see
`packages/client/README.md`.

On a server, serve `apps/widget/dist` (with `loader.js` copied in) as static files behind your TLS
proxy (for example `https://chat.example.com`). Set `PUBLIC_WIDGET_ORIGIN` to that origin, and
list each customer website in the brand's `allowedOrigins`.

### Studio in development

```bash
pnpm --filter @hamnivo/console dev   # http://localhost:5173
```

The development server passes `/v1` and `/api/auth` on to the API at `http://localhost:4000`
(`HAMNIVO_GATEWAY_URL` changes that), so Studio and the API share one origin. Sign up there. Without
SMTP, the confirmation link is in the API's log. `apps/console/README.md` describes the screens
and the browser tests.

### The public website

`apps/site` is a static site in English, Arabic, Hindi and Urdu. It uses the brand's product
visuals, and every page passes an accessibility audit in the checks.

```bash
pnpm --filter @hamnivo/brand build
pnpm --filter @hamnivo/site build        # static files in apps/site/dist
pnpm --filter @hamnivo/site preview      # http://localhost:5190
```

Serve `apps/site/dist` from any web server or CDN. Set these at build time:
- `PUBLIC_SITE_URL`: the address used in canonical links and the sitemap.
- To embed a live chat demo: `PUBLIC_HAMNIVO_WIDGET_ID`, `PUBLIC_HAMNIVO_WIDGET_ORIGIN` and
  `PUBLIC_HAMNIVO_API`. Without them, the page shows the loader snippet instead.

## 5. Run the checks

```bash
pnpm ci:local                   # everything; about 8–12 minutes
pnpm ci:local --quick           # lint, typecheck, unit tests, status and licence checks
pnpm ci:local --skip-a11y       # everything except the Storybook accessibility audit
pnpm ci:local --skip-chatwoot   # everything except the real-Chatwoot contract suite
pnpm ci:local --skip-e2e        # everything except the browser checks (widget journey, website)
pnpm ci:local --skip-basics     # everything except lint, typecheck, unit tests and the --quick checks
pnpm ci:local --skip-integration # everything except the integration tests
PG_VERSIONS=18 pnpm ci:local
```

Integration tests run in throwaway containers with fresh random passwords, so your development data
is never touched:

- PostgreSQL 16 and 18 with Valkey, for the database and gateway tests.
- A complete Chatwoot v4.18.0-ce on a random port, for the contract suite. The checks delete it
  afterwards, volumes included.
- A fresh PostgreSQL 18 and Valkey for the widget journey. It builds everything, then starts the
  gateway, the worker, a fake Chatwoot, the widget and a host page on another origin. Chromium
  then chats through it: AI reply, staff takeover, offline resend, right to left, an axe audit,
  and refusal on a website that is not allowed. WebKit, Safari's engine, runs the same journeys
  and the composer's tests (`apps/widget/playwright.config.ts`).

- The built website in Chromium: every language at desktop and phone width, with an axe audit.

The checks write `test-results/ci-local.md`. On the CI runner, the Actions run summary shows the
report and where the full `test-results/` archive is kept: a file on the CI server, never a GitHub
artifact, one per suite. Copy one with its run ID, attempt number and suite (`basics`,
`integration-pg18-1`, `chatwoot`, `studio`, `production-smoke`, ...):

```bash
scp root@CI_SERVER:/opt/hamnivo-ci-runner/results/ci-results-RUN_ID-ATTEMPT-SUITE.tar.gz .
```

### Run the checks on GitHub, for free

Every push runs this pipeline on GitHub Actions (ADR 0009), on runners of your own, and GitHub
bills nothing for it (ADR 0020). It is split into suites that run side by side, one job each: the
integration tests in three parts per PostgreSQL version, Studio's browser tests in three parts,
and each other browser check on its own. At most two of these heavy suites run at once
(`max-parallel` in `ci.yml`): the runners share one server's CPUs, and more at once made the tests
time out. A push to a branch other than main runs only typecheck and unit tests, for
the packages its change reaches (lint runs on main, weekly and by hand only). A push to main (a
merge) runs the suites reached since the last commit main passed (`scripts/ci/plan.mjs`),
on PostgreSQL 18, with lint and the quick checks on every package and the smoke tests when a deploy
file changes; a change to Markdown or `docs/` alone runs only those basics. The weekly run (Saturday
23:00 UTC) and runs by hand run every suite, test 16 too, and run the production and automatic-deploy
smoke tests. A branch push of a tree that an earlier run already passed is not checked again.

- Self-hosted runners are free.
- Caches stay on the runner's disk, and results stay on the server.
- `pnpm ci:local` fails any workflow change that would use GitHub's hosted runners, artifact
  storage, cache storage or Packages (`scripts/ci/no-github-billing.sh`).

Set it up once:

1. **Get a server for it.** It needs Ubuntu 22.04 or later (or Debian 12 or later) on x86_64, at
   least 4 GB of memory (8 GB or more is better), 40 GB of free disk, and outbound HTTPS. It needs
   no open port. Don't use the production server: the checks build images with the same names,
   and they would slow the live service. If the production server is the only machine you have,
   use the capped setup in [On the production server](#on-the-production-server) instead
   (ADR 0019).
2. **Install the runner.** From a checkout of this repository:

   ```bash
   scp -r deploy/ci-runner root@CI_SERVER:/root/hamnivo-ci-runner-setup
   ```

   ```bash
   ssh -t root@CI_SERVER bash /root/hamnivo-ci-runner-setup/install.sh
   ```

   It installs Docker if it is missing and copies the runner to `/opt/hamnivo-ci-runner`. It caps
   the checks in `hamnivo-ci.slice`, sized to the machine, and leaves a tenth of the memory (at
   least 1 GB) for ssh and Docker. Then it asks for a registration token: on GitHub, open
   **Settings → Actions → Runners → New self-hosted runner**, and copy the value after `--token`.
   The runner registers with the labels `self-hosted, linux, x64, hamnivo`, starts, and shows as
   Idle on that page. Run the same two commands again to update it; set `HAMNIVO_CI_CPUS`,
   `HAMNIVO_CI_MEMORY_GB` and the other variables in the script's header to size it yourself.
   If the server also runs other repositories' runners, use the shared
   [github-runners](https://github.com/CodeWithJuber/github-runners) kit instead of these two
   commands: it runs Hamnivo's runner from `repos/hamnivo.env`, next to the others, under one cap.
   The results are then in `/opt/github-runners/results/hamnivo`.
3. **Retire any older runner.** Every runner with the `hamnivo` label takes jobs. On the server
   it ran on, stop it with `cd /opt/hamnivo-ci-runner && docker compose down`, then remove it
   under **Settings → Actions → Runners**.
4. **Make sure GitHub can never bill.** On GitHub, open **Settings → Billing and licensing →
   Budgets and alerts → New budget**. Choose Actions, set the amount to 0, turn on **Stop usage
   when budget limit is reached**, and create it. A mistake can then fail a job, but not cost
   anything.
5. **Make `main` wait for the checks.** Under **Settings → Branches**, in the rule for `main`, turn
   on "Require status checks to pass" and pick `checks`. For a private repository GitHub offers
   this only on a paid plan; without it, check that `checks` passed before you merge.

A newer push to the same branch cancels the run that is still going. Runs wait in the queue
until a runner is online; GitHub fails a job that has waited 24 hours.

What the runner keeps on the server, so no run downloads it again:

| What | Where |
| --- | --- |
| pnpm's package store, pruned to what the last run used | the `work` volume, `_pnpm-store` |
| Playwright's browsers and other tool caches | the `runner-cache` volume |
| Turbo's cache (a week), shared by all runners under the github-runners kit; only pushes to `main` and the weekly run write it | `CI_RESULTS_DIR/turbo-cache`, else the `runner-cache` volume |
| Docker images and the build cache of the smoke tests (a week) | the `dind-data` volume |
| Each run's `test-results/` (14 days, `HAMNIVO_CI_RESULTS_DAYS`) | `/opt/hamnivo-ci-runner/results` |

The runner is GitHub's own image (`ghcr.io/actions/actions-runner`), and it updates itself, as
GitHub requires: GitHub stops sending jobs to a runner more than 63 days behind. Its logs:
`cd /opt/hamnivo-ci-runner && docker compose logs -f runner`.

#### On the production server

`deploy/ci-runner/` runs the runner in a container next to a Docker daemon of its own, so the
images, containers and ports the checks create never reach the Docker that serves production.
Both containers, and everything the inner daemon starts, live in the systemd slice
`hamnivo-ci.slice`: at most 3 CPUs and 4 GB, no swap, and the lowest CPU and disk priority. When
the checks run out of memory, the kernel stops a check, not the live service. As root:

```bash
install -d -m 700 /opt/hamnivo-ci-runner
install -d -m 700 -o 1001 -g 1001 /opt/hamnivo-ci-runner/state     # the runner's user in its image
install -d -m 750 -o 1001 -g 1001 /opt/hamnivo-ci-runner/results
cp deploy/ci-runner/{compose.yaml,Dockerfile,entrypoint.sh} /opt/hamnivo-ci-runner/
cp deploy/ci-runner/hamnivo-ci.slice /etc/systemd/system/
systemctl daemon-reload && systemctl start hamnivo-ci.slice
# A one-time registration token, from a machine where gh is signed in as a repository admin:
#   gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token \
#     | ssh root@SERVER 'umask 077; cat > /opt/hamnivo-ci-runner/state/token; chown 1001:1001 /opt/hamnivo-ci-runner/state/token'
cd /opt/hamnivo-ci-runner && docker compose up -d --build
```

Without a `.env` file, `compose.yaml` uses these sizes, the repository's URL and the name
`compute-hamnivo-ci`. Set `HAMNIVO_CI_REPO_URL` in `.env` for a repository of your own. With
4 GB the checks run at most two turbo tasks at once (`HAMNIVO_CI_CONCURRENCY=2`), and type checks
and builds one at a time (`HAMNIVO_CI_HEAVY_CONCURRENCY=1`), so they take longer than on a laptop.
With `HAMNIVO_CI_CONCURRENCY` set, each package's unit tests also get their share of the CPUs
(`VITEST_MAX_WORKERS`, which `pnpm ci:local` sets when it is not set already), so the tests turbo
runs side by side do not start more workers than there are CPUs.

To run the quick checks automatically before every `git push`:

```bash
git config core.hooksPath .githooks
```

## 6. Look at the design system

```bash
pnpm --filter @hamnivo/brand build
pnpm --filter @hamnivo/ui storybook          # http://localhost:6006
# or build a static copy and serve it with any web server:
pnpm --filter @hamnivo/ui build-storybook    # output: packages/ui/storybook-static/
```

## 7. Updating

```bash
git pull
pnpm install
bash scripts/setup/env.sh   # adds any new secrets without touching existing ones
pnpm services:up            # also re-applies database roles
pnpm db:migrate
pnpm ci:local
```

## Coming with the next milestones

- Studio, the staff console, served at `app.` by the same web server.
- Monitoring dashboards and alerts (ops round).
