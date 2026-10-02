import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkEgressUrl,
  EgressError,
  guardedFetch,
  hostAllowed,
  isPublicAddress,
} from '../src/egress/index.js';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.9',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.10',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1',
    '2001:db8::1',
    'fe80::1%eth0',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('hostAllowed and checkEgressUrl', () => {
  it('matches exact hosts and wildcard subdomains only', () => {
    expect(hostAllowed('orders.example.com', ['orders.example.com'])).toBe(true);
    expect(hostAllowed('ORDERS.example.com.', ['orders.example.com'])).toBe(true);
    expect(hostAllowed('api.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('evilexample.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('orders.example.com.evil.net', ['orders.example.com'])).toBe(false);
  });

  it('refuses plain HTTP, credentials, hosts off the list and private literals', () => {
    const policy = { allowedHosts: ['orders.example.com', '10.0.0.5'] };
    const refusal = (url: string) => {
      try {
        checkEgressUrl(new URL(url), policy);
        return null;
      } catch (error) {
        return error instanceof EgressError ? error.reason : 'other';
      }
    };
    expect(refusal('https://orders.example.com/mcp')).toBeNull();
    expect(refusal('http://orders.example.com/mcp')).toBe('protocol');
    expect(refusal('https://user:pw@orders.example.com/mcp')).toBe('protocol');
    expect(refusal('https://other.example.com/mcp')).toBe('host_not_allowed');
    expect(refusal('https://10.0.0.5/mcp')).toBe('private_address');
  });
});

describe('guardedFetch', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(5000));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, method: req.method }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A resolver that answers every name with the given addresses. */
  const resolver = (...addresses: string[]) =>
    ((_host: string, _options: unknown, callback: (e: null, a: LookupAddress[]) => void) =>
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      )) as never;

  it('refuses a public name that resolves to an internal address (DNS rebinding)', async () => {
    const fetch = guardedFetch({
      allowedHosts: ['metadata.attacker.example'],
      lookup: resolver('169.254.169.254'),
    });
    await expect(fetch('https://metadata.attacker.example/latest')).rejects.toMatchObject({
      reason: 'private_address',
    });
    const mixed = guardedFetch({
      allowedHosts: ['mixed.attacker.example'],
      lookup: resolver('93.184.216.34', '10.0.0.1'),
    });
    await expect(mixed('https://mixed.attacker.example/')).rejects.toMatchObject({
      reason: 'private_address',
    });
  });

  it('reaches an allowed local test server only when private addresses are allowed', async () => {
    const url = `http://127.0.0.1:${port}/ok`;
    await expect(guardedFetch({ allowedHosts: ['127.0.0.1'] })(url)).rejects.toMatchObject({
      reason: 'protocol',
    });
    const response = await guardedFetch({ allowedHosts: ['127.0.0.1'], allowPrivate: true })(url, {
      method: 'POST',
      body: '{}',
    });
    expect(await response.json()).toEqual({ ok: true, method: 'POST' });
  });

  it('does not follow redirects and stops oversized bodies', async () => {
    const fetch = guardedFetch({
      allowedHosts: ['127.0.0.1'],
      allowPrivate: true,
      maxResponseBytes: 1000,
    });
    await expect(fetch(`http://127.0.0.1:${port}/redirect`)).rejects.toMatchObject({
      reason: 'redirect',
    });
    const big = await fetch(`http://127.0.0.1:${port}/big`);
    await expect(big.text()).rejects.toMatchObject({ reason: 'response_too_large' });
  });
});
