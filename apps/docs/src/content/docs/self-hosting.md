---
title: Self-hosting made simple
description: What you need and the five commands to run Hamnivo on your own server
---

Run Hamnivo on your own server with automatic HTTPS and backups. No DevOps experience needed.

## What you need

1. **A server** with Ubuntu 24.04 LTS, 4 CPU cores, 8 GB memory, and 40 GB storage
2. **A domain** you control (e.g., `example.com`)
3. **DNS records** pointing at your server for `app.example.com`, `api.example.com`, `chat.example.com`, `support.example.com`
4. **Port 80 and 443 open** (for HTTPS)
5. **Email (optional)** for sign-in and team invitations

## What happens when you start

1. You get Studio at `app.example.com`
2. Your chat appears on your website
3. Your team can answer customers
4. AI is ready to help (optional)
5. Backups run when you schedule them (see below)

All automatic. No code to write.

## The five commands

Run these in order on your server. Copy-paste them.

### 1. Install Docker and git

```bash
sudo apt-get update && sudo apt-get install -y git openssl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# Log out and back in
```

### 2. Get the code

The code is in a public repository, so the server needs no key to read it.

```bash
sudo mkdir -p /opt/hamnivo && sudo chown "$USER" /opt/hamnivo
git clone https://github.com/CodeWithJuber/Hamnivo.git /opt/hamnivo
cd /opt/hamnivo
```

Deploying from a private copy instead? The full guide (`docs/self-hosting.md`, section A3)
shows how to give the server a read-only deploy key.

### 3. Set up your domain

```bash
./deploy/production/hamnivo.sh setup --domain example.com --email you@example.com
```

Replace `example.com` with your domain and `you@example.com` with your email.

This creates a `.env` file with your settings, passwords and secrets (never commit it).

### 4. Start everything

```bash
./deploy/production/hamnivo.sh up
```

This:
- Builds Docker images
- Starts the database, Valkey (cache), Chatwoot, API, and chat
- Gets HTTPS certificates from Let's Encrypt
- Starts Studio at `app.example.com`

Takes 5–15 minutes the first time.

### 5. Check health

```bash
./deploy/production/hamnivo.sh doctor
```

This tells you if everything is running. If anything is wrong, it suggests fixes.

## Verify it's working

1. Open `app.example.com` in your browser
2. Create an account
3. Set up a brand with your website
4. Copy the install code and put it on your website
5. Test the chat

## Backups and restore

Make a backup any time:

```bash
./deploy/production/hamnivo.sh backup
```

It saves your database, uploaded files and settings in a folder under
`deploy/production/backups/`, named after the time. To run it every night at 03:15:

```bash
( crontab -l 2>/dev/null; echo '15 3 * * * /opt/hamnivo/deploy/production/hamnivo.sh backup >> "$HOME/hamnivo-backup.log" 2>&1' ) | crontab -
```

Backups stay on the server, so copy them somewhere else too.

To restore, give the backup folder:

```bash
./deploy/production/hamnivo.sh restore deploy/production/backups/20261003T031500Z
```

## Update Hamnivo

With automatic deploys on, every change on GitHub goes live by itself. To update by hand:

```bash
./deploy/production/hamnivo.sh update
```

It downloads the new version, checks and builds it, starts it, and goes back to the
previous version if it does not stay healthy.

## Troubleshooting

### The domain doesn't work

Check that your DNS records point at the server's IP address. It can take a few minutes.

```bash
nslookup app.example.com
```

It should show your server's IP.

### HTTPS isn't working

Run `hamnivo.sh doctor`. It checks certificates and DNS.

If your domain is behind Cloudflare:
1. Run `./deploy/production/hamnivo.sh setup --cloudflare on`, then `up`
2. Set SSL/TLS mode to "Full (strict)"
3. Turn "Always Use HTTPS" **off** until Caddy has its certificates

### Can't send emails

Sign-ups and invitations need email. If emails aren't sending:

1. Add your email details to `deploy/production/.env`:
   ```
   SMTP_URL=smtps://user:password@smtp.example.com:465
   MAIL_FROM="Hamnivo <no-reply@example.com>"
   ```

2. Restart:
   ```bash
   ./deploy/production/hamnivo.sh up
   ```

3. Test: ask for a password reset on the sign-in page and check your inbox.

### The disk fills up

Run `./deploy/production/hamnivo.sh doctor`. It shows free space and the size of Docker's
build cache, and how to clear it (`docker builder prune -af`). Never run
`docker volume prune`: it deletes your data.

## Security

- **HTTPS** is automatic and required
- **Two-step sign-in** (an authenticator app or a passkey) protects admin accounts
- **Audit logs** track everything (who answered, when settings changed)
- **Backups** stay on your server: copy them somewhere safe as well

For more security:
- Use Cloudflare's proxy to hide your server IP
- Set firewall rules to allow only ports 80 and 443
- Use a VPN for your team's sign-in (optional)

## Cost

Running Hamnivo costs:
- **Server**: ~$20/month for a basic VPS
- **Domain**: ~$10/year
- **Email**: Free (Gmail), or $5/month (Mailgun)
- **AI models**: Only if you use real models (Anthropic, OpenAI, etc.)

## Need help?

See `docs/self-hosting.md` in the code repository for detailed setup, automatic deploys, and troubleshooting.

Or run `./deploy/production/hamnivo.sh help` for all commands.
