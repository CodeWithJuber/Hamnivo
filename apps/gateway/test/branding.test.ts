import { BrandingHostname } from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { checkPortalDns, portalHostname } from '../src/branding/branding.service.js';
import { brandCustomerMessage } from '../src/branding/customer-email.js';

describe('portal trust boundaries', () => {
  it('accepts only exact public DNS hostnames', () => {
    expect(BrandingHostname.parse('Portal.Example.com')).toBe('portal.example.com');
    for (const value of [
      'https://example.com',
      '*.example.com',
      'example.com:443',
      'example.com/path',
      'example.com\n{',
      '127.0.0.1',
      'localhost',
      'foo.local',
    ]) {
      expect(BrandingHostname.safeParse(value).success, value).toBe(false);
    }
    expect(portalHostname('EXAMPLE.com:443')).toBe('example.com');
    expect(portalHostname('example.com@evil.com')).toBeNull();
    expect(portalHostname('example.com/evil')).toBeNull();
  });
  it('joins DNS TXT chunks and requires the exact tenant challenge', async () => {
    const names: string[] = [];
    const dns = {
      async resolveTxt(name: string) {
        names.push(name);
        return [['hamnivo-portal=', 'owner-a'], ['irrelevant']];
      },
    };
    expect(await checkPortalDns(dns, 'portal.example.com', 'owner-a')).toBe('verified');
    expect(await checkPortalDns(dns, 'portal.example.com', 'owner-b')).toBe('not_found');
    expect(names).toEqual([
      '_hamnivo-portal.portal.example.com',
      '_hamnivo-portal.portal.example.com',
    ]);
  });
  it('distinguishes absent ownership from resolver outages', async () => {
    const failing = (code: string) => ({
      async resolveTxt() {
        throw Object.assign(new Error(), { code });
      },
    });
    expect(await checkPortalDns(failing('ENODATA'), 'portal.example.com', 'x')).toBe('not_found');
    expect(await checkPortalDns(failing('ESERVFAIL'), 'portal.example.com', 'x')).toBe(
      'lookup_failed',
    );
  });
});
describe('customer email presentation', () => {
  it('escapes message content and preserves routing/template headers', () => {
    const message = brandCustomerMessage(
      {
        to: 'customer@example.com',
        subject: 'Reply',
        text: '<script>bad</script>\nHello & welcome',
        template: 'customer.reply_waiting',
        headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
      },
      'Fallback',
      {
        senderName: 'Acme Help',
        replyTo: 'help@example.com',
        logoUrl: 'https://example.com/logo.png?a=1&b=2',
      },
    );
    expect(message.senderName).toBe('Acme Help');
    expect(message.replyTo).toBe('help@example.com');
    expect(message.html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(message.html).toContain('a=1&amp;b=2');
    expect(message.html).not.toContain('<script>');
    expect(message.headers?.['List-Unsubscribe']).toBe('<https://example.com/unsubscribe>');
    expect(message).not.toHaveProperty('from');
    expect(() =>
      brandCustomerMessage(message, 'Fallback', {
        senderName: 'Bad\r\nBcc: x',
        replyTo: null,
        logoUrl: null,
      }),
    ).toThrow();
  });
});
