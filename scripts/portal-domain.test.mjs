import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portalIndex, portalSite } from './portal-domain.mjs';

test('explicit site generation refuses Caddy injection and catches all API routes behind ownership gate', () => {
  for (const hostname of [
    '*.example.com',
    'a.example.com\n{respond hacked}',
    'https://a.example.com',
    'a.example.com:443',
    '../etc/caddy',
  ])
    assert.throws(() => portalSite(hostname));
  const site = portalSite('portal.example.com');
  assert.ok(site.startsWith('# Explicit portal route'));
  assert.ok(site.includes('portal.example.com {'));
  assert.ok(site.includes('forward_auth api:4000'));
  assert.ok(site.includes('uri /v1/branding'));
  assert.ok(site.includes('@api path /v1/* /api/auth/*'));
  assert.ok(site.indexOf('forward_auth') < site.indexOf('@api'));
});
test('portal index chooses same origin and removes old runtime API override', () => {
  const html = portalIndex(
    '<html><head><meta name="hamnivo-api" content="https://old.example.com"></head><body></body></html>',
  );
  assert.equal(html.match(/name="hamnivo-api"/g).length, 1);
  assert.ok(html.includes('content="self"'));
  assert.ok(!html.includes('https://old.example.com'));
});
