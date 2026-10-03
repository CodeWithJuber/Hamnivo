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
5. Backups run daily

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

```bash
git clone https://github.com/juber-shaikh/hamnivo.git
cd hamnivo
```

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

Backups run every day at midnight. They store:
- Your database (conversations, users, AI settings)
- Uploaded files
- Configuration

To restore from a backup:

```bash
./deploy/production/hamnivo.sh restore --from 2026-10-03
```

Replace the date with when you want to restore to.

## Update Hamnivo

New versions come out regularly with bug fixes and features.

```bash
git pull
./deploy/production/hamnivo.sh up
```

It:
- Downloads the new code
- Checks everything is healthy
- Restarts with the new version
- Rolls back if something breaks

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
1. Set SSL/TLS mode to "Full (strict)"
2. Turn "Always Use HTTPS" **off**
3. Caddy gets certificates itself

### Can't send emails

Sign-ups and invitations need email. If emails aren't sending:

1. Add your SMTP details to `.env`:
   ```
   MAIL_HOST=smtp.yourprovider.com
   MAIL_PORT=587
   MAIL_FROM=no-reply@example.com
   MAIL_USER=your-email@example.com
   MAIL_PASSWORD=your-password
   ```

2. Restart:
   ```bash
   ./deploy/production/hamnivo.sh up
   ```

3. Test:
   ```bash
   ./deploy/production/hamnivo.sh mail you@example.com
   ```

### The database fills up

Hamnivo stores everything, including audit logs. To free space:
1. Delete conversations older than 1 year (in Studio)
2. Clear audit logs older than 90 days (in Settings)

## Security

- **HTTPS** is automatic and required
- **Two-step verification** is mandatory for publishing changes
- **Audit logs** track everything (who answered, when settings changed)
- **Backups** are encrypted and stored on the server

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

Or run `./deploy/production/hamnivo.sh --help` for all commands.
