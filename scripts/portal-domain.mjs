#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function portalIndex(html) {
  return html
    .replace(/<meta\b[^>]*\bname=["']hamnivo-api["'][^>]*>/gi, '')
    .replace('</head>', '<meta name="hamnivo-api" content="self"></head>');
}
export function portalSite(hostname) {
  if (
    typeof hostname !== 'string' ||
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
  ) {
    throw new Error('Pass one lowercase DNS hostname, without a wildcard, port, scheme or path.');
  }
  return `# Explicit portal route; install only after DNS ownership verification.\n${hostname} {
  import tls
  import headers
  route {
    # Every request is gated, including existing sessions and assets after a domain is disabled.
    forward_auth api:4000 {
      uri /v1/branding
      header_up Host ${hostname}
    }
    @api path /v1/* /api/auth/*
    handle @api {
      reverse_proxy api:4000 {
        header_up Host ${hostname}
        header_up X-Forwarded-For {client_ip}
      }
    }
    @assets path /assets/*
    handle @assets {
      root * /srv/studio
      header Cache-Control "public, max-age=31536000, immutable"
      file_server
    }
    handle {
      root * /srv/portal
      rewrite * /index.html
      header {
        Cache-Control no-store
        X-Frame-Options DENY
        Content-Security-Policy "default-src 'self'; script-src 'self' {$HAMNIVO_CAPTCHA_ORIGIN}; frame-src 'self' {$HAMNIVO_CAPTCHA_ORIGIN} {$HAMNIVO_CHAT_ORIGIN}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      }
      file_server
    }
  }
}
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--index') {
      const [input, output] = process.argv.slice(3);
      if (!input || !output) throw new Error('Usage: portal-domain.mjs --index INPUT OUTPUT');
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, portalIndex(await readFile(input, 'utf8')));
    } else {
      if (process.argv.length !== 3) throw new Error('Usage: portal-domain.mjs HOSTNAME');
      process.stdout.write(portalSite(process.argv[2]));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
