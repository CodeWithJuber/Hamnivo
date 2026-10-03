import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { HamnivoWebhookEvent } from '@hamnivo/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const previous = `whsec_${randomBytes(32).toString('base64')}`;
const handled: HamnivoWebhookEvent[] = [];
let failNext = false;
let base = '';
let close: () => Promise<void>;

/** Signs like the Hamnivo gateway (Standard Webhooks v1), independently of the SDK. */
function sign(key: string, id: string, timestamp: number, body: string): string {
  const bytes = Buffer.from(key.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', bytes).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function event(id: string) {
  return JSON.stringify({
    id,
    type: 'order.updated',
    timestamp: new Date().toISOString(),
    schemaVersion: '1.0',
    tenantId: 'tnt_01k6a3p0a1b2c3d4e5f6g7h8j9',
    data: { order: { id: 'ord_01k6a3p0a1b2c3d4e5f6g7h8j9', state: 'fulfilled' } },
  });
}

async function deliver(
  body: string,
  options: { id: string; signature?: string; timestamp?: number; key?: string },
) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const response = await fetch(`${base}/hamnivo/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': options.id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature':
        options.signature ?? sign(options.key ?? secret, options.id, timestamp, body),
    },
    body,
  });
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const server = createApp({
    widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
    widgetOrigin: 'https://chat.example.com',
    api: 'https://api.example.com',
    key: { kid: 'hk_shop', alg: 'HS256', secret: randomBytes(32).toString('base64url') },
    webhookSecret: [secret, previous],
    onWebhook: (received) => {
      if (failNext) {
        failNext = false;
        throw new Error('database down');
      }
      handled.push(received);
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close?.();
});

describe('webhook receiver', () => {
  it('handles a signed event once and answers a repeat with 200', async () => {
    const body = event('evt_01k6a3p0a1b2c3d4e5f6g7h8j1');
    expect((await deliver(body, { id: 'evt_01k6a3p0a1b2c3d4e5f6g7h8j1' })).status).toBe(204);
    expect(handled.map((e) => e.id)).toEqual(['evt_01k6a3p0a1b2c3d4e5f6g7h8j1']);
    // Hamnivo retries with the same id: acknowledged, not handled twice.
    expect((await deliver(body, { id: 'evt_01k6a3p0a1b2c3d4e5f6g7h8j1' })).status).toBe(200);
    expect(handled).toHaveLength(1);
  });

  it('accepts the previous secret during a rotation', async () => {
    const body = event('evt_01k6a3p0a1b2c3d4e5f6g7h8j2');
    const response = await deliver(body, { id: 'evt_01k6a3p0a1b2c3d4e5f6g7h8j2', key: previous });
    expect(response.status).toBe(204);
  });

  it('refuses forged, altered and stale requests', async () => {
    const id = 'evt_01k6a3p0a1b2c3d4e5f6g7h8j3';
    const body = event(id);
    const forged = await deliver(body, {
      id,
      key: `whsec_${randomBytes(32).toString('base64')}`,
    });
    expect(forged).toEqual({ status: 400, text: JSON.stringify({ error: 'invalid_signature' }) });
    const timestamp = Math.floor(Date.now() / 1000);
    const altered = await deliver(body.replace('fulfilled', 'cancelled'), {
      id,
      timestamp,
      signature: sign(secret, id, timestamp, body),
    });
    expect(altered.status).toBe(400);
    const stale = await deliver(body, { id, timestamp: timestamp - 3600 });
    expect(stale).toEqual({
      status: 400,
      text: JSON.stringify({ error: 'timestamp_out_of_range' }),
    });
    expect(handled.some((e) => e.id === id)).toBe(false);
  });

  it('processes the retry when handling failed the first time', async () => {
    const id = 'evt_01k6a3p0a1b2c3d4e5f6g7h8j4';
    const body = event(id);
    failNext = true;
    const first = await deliver(body, { id });
    expect(first.status).toBe(500);
    expect(first.text).not.toContain('database');
    expect((await deliver(body, { id })).status).toBe(204);
    expect(handled.filter((e) => e.id === id)).toHaveLength(1);
  });
});

describe('webhook settings', () => {
  const base = {
    HAMNIVO_WIDGET_ID: 'wid_x',
    HAMNIVO_IDENTITY_KID: 'k',
    HAMNIVO_IDENTITY_SECRET: 's',
  };

  it('reads one or two signing secrets and refuses anything else', () => {
    expect(readConfig(base).webhookSecret).toBeUndefined();
    expect(
      readConfig({ ...base, HAMNIVO_WEBHOOK_SECRET: `${secret}, ${previous}` }).webhookSecret,
    ).toEqual([secret, previous]);
    expect(() => readConfig({ ...base, HAMNIVO_WEBHOOK_SECRET: 'not-a-secret' })).toThrow(
      /HAMNIVO_WEBHOOK_SECRET/,
    );
    expect(() => readConfig({ ...base, HAMNIVO_WEBHOOK_SECRET: 'not-a-secret' })).not.toThrow(
      /not-a-secret/,
    );
  });
});
