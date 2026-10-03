import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkDestination, EgressError, type Resolver } from '@hamnivo/adapters/net';
import type { Db } from '@hamnivo/db';
import { describe, expect, it } from 'vitest';
import { checkMcpServer, mcpTrustedOrigins } from '../src/actions/adapters.js';
import type { AppConfig } from '../src/config.js';
import { EgressService } from '../src/developer/egress.service.js';
import { WebhookSender } from '../src/developer/webhooks/sender.service.js';
import { generateSigningSecret } from '../src/developer/webhooks/signing.js';
import type { SecretBroker } from '../src/secrets/secret-broker.service.js';

/**
 * How the gateway puts the one egress guard (`@hamnivo/adapters/net`, tested there) to work: the
 * policy each caller gets, which trusted origins each caller keeps, and a webhook that is refused
 * when its name turns private between the check and the connection.
 */

const PUBLIC = { address: '93.184.216.34', family: 4 } as const;
const LOOPBACK = { address: '127.0.0.1', family: 4 } as const;

const refusal = (run: () => void) => {
  try {
    run();
  } catch (error) {
    return error instanceof EgressError ? error.problem : 'other';
  }
  return 'allowed';
};

describe('the policy each caller gets', () => {
  const config = { EGRESS_TRUSTED_ORIGINS: ['http://10.0.0.5:8080'] } as AppConfig;
  const service = (resolve?: Resolver) =>
    new EgressService({} as Db, config, () => new Date(), resolve);

  it('is the workspace’s list and the administrator’s trusted origins, and no list means any public host', () => {
    expect(service().policy([])).toEqual({ trustedOrigins: ['http://10.0.0.5:8080'] });
    expect(service().policy(['hooks.example.com', '*.example.net'])).toEqual({
      allowedHosts: ['hooks.example.com', '*.example.net'],
      trustedOrigins: ['http://10.0.0.5:8080'],
    });
  });

  it('keeps the trusted origins of the caller’s own setting, not the webhooks’', () => {
    expect(service().policy(['hooks.example.com'], [])).toEqual({
      allowedHosts: ['hooks.example.com'],
      trustedOrigins: [],
    });
    expect(service().policy([], ['https://idp.corp.internal'])).toEqual({
      trustedOrigins: ['https://idp.corp.internal'],
    });
  });

  it('hands the resolver to the guard when tests replace DNS', () => {
    const resolve: Resolver = async () => [PUBLIC];
    expect(service(resolve).policy([]).resolve).toBe(resolve);
    expect(service().policy([])).not.toHaveProperty('resolve');
  });

  it('shows which addresses the workspace’s list lets through, trusted origins always', () => {
    const egress = service();
    const limited = egress.policy(['hooks.example.com']);
    expect(egress.allows(limited, 'https://hooks.example.com/hv')).toBe(true);
    expect(egress.allows(limited, 'https://other.example.com/hv')).toBe(false);
    expect(egress.allows(limited, 'http://10.0.0.5:8080/hv')).toBe(true);
    expect(egress.allows(egress.policy([]), 'https://anything.example.com/hv')).toBe(true);
    expect(egress.allows(limited, 'not a url')).toBe(false);
  });
});

describe('MCP servers', () => {
  it('trust no origin, but the server’s own where development and tests allow private ones', () => {
    const url = 'http://127.0.0.1:9000/mcp';
    expect(mcpTrustedOrigins({ TOOLS_EGRESS_ALLOW_PRIVATE: false }, url)).toEqual([]);
    expect(mcpTrustedOrigins({ TOOLS_EGRESS_ALLOW_PRIVATE: true }, url)).toEqual([
      'http://127.0.0.1:9000',
    ]);
    expect(mcpTrustedOrigins({ TOOLS_EGRESS_ALLOW_PRIVATE: true }, 'not a url')).toEqual([]);
  });

  it('are reached only where the tool’s list and the workspace’s list both allow', () => {
    const url = 'https://mcp.partner.example/mcp';
    const tool = ['mcp.partner.example'];
    const anywhere = {};
    expect(refusal(() => checkMcpServer(url, tool, anywhere))).toBe('allowed');
    expect(refusal(() => checkMcpServer(url, ['*.partner.example'], anywhere))).toBe('allowed');
    // The tool’s own list: not covering the server, or empty, reaches nothing.
    expect(refusal(() => checkMcpServer(url, ['loyalty.example.com'], anywhere))).toBe(
      'host_not_allowed',
    );
    expect(refusal(() => checkMcpServer(url, [], anywhere))).toBe('host_not_allowed');
    // The workspace’s list applies too.
    const workspace = { allowedHosts: ['hooks.example.com'] };
    expect(refusal(() => checkMcpServer(url, tool, workspace))).toBe('host_not_allowed');
    expect(refusal(() => checkMcpServer(url, tool, { allowedHosts: ['*.partner.example'] }))).toBe(
      'allowed',
    );
  });

  it('are public HTTPS, whatever either list says', () => {
    for (const [url, problem] of [
      ['http://mcp.partner.example/mcp', 'insecure_url'],
      ['https://user:pw@mcp.partner.example/mcp', 'invalid_url'],
      ['https://10.0.0.5/mcp', 'private_address'],
      ['https://[::1]/mcp', 'private_address'],
      ['https://metadata.google.internal/mcp', 'private_address'],
      ['not a url', 'invalid_url'],
    ] as const) {
      // A list that names the host: the address itself is what is refused.
      const host = URL.canParse(url) ? new URL(url).hostname : '';
      expect(
        refusal(() => checkMcpServer(url, [host], {})),
        url,
      ).toBe(problem);
    }
  });

  it('may be private only as a trusted origin, and the tool’s list still applies to it', () => {
    const url = 'http://127.0.0.1:9000/mcp';
    const trusted = { trustedOrigins: ['http://127.0.0.1:9000'] };
    expect(refusal(() => checkMcpServer(url, ['127.0.0.1'], trusted))).toBe('allowed');
    // Trusted for the workspace, but the tool’s list does not name the host.
    expect(refusal(() => checkMcpServer(url, ['loyalty.example.com'], trusted))).toBe(
      'host_not_allowed',
    );
    // The workspace’s list does not hold a trusted origin back.
    expect(
      refusal(() =>
        checkMcpServer(url, ['127.0.0.1'], { ...trusted, allowedHosts: ['hooks.example.com'] }),
      ),
    ).toBe('allowed');
    expect(refusal(() => checkMcpServer(url, ['127.0.0.1'], {}))).toBe('insecure_url');
  });
});

describe('webhook deliveries', () => {
  it('are refused when the name turned private between the check and the connection', async () => {
    const hits: string[] = [];
    const receiver = createServer((request, response) => {
      hits.push(request.url ?? '');
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const { port } = receiver.address() as AddressInfo;
    try {
      // When the endpoint was saved the name was public; now it points at this machine.
      let lookups = 0;
      const rebinding: Resolver = async () => [lookups++ === 0 ? PUBLIC : LOOPBACK];
      const url = `https://hooks.partner.example:${port}/hv`;
      const policy = { resolve: rebinding };
      await checkDestination(url, policy);

      const sender = new WebhookSender(
        { WEBHOOK_TIMEOUT_MS: 2000 } as AppConfig,
        () => new Date(),
        {} as SecretBroker,
        {} as EgressService,
      );
      const attempt = await sender.attempt(
        { url, secrets: [generateSigningSecret()], policy },
        randomUUID(),
        '{"type":"webhook.test"}',
      );
      expect(attempt.judgement).toMatchObject({ outcome: 'blocked', statusCode: null });
      expect(attempt.judgement.error).toMatch(/private/i);
      expect(lookups).toBe(2);
      expect(hits).toEqual([]);
    } finally {
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});
