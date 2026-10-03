import { HamnivoClient, MemoryStorage } from '@hamnivo/client';
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { BrandMark } from '../src/components/BrandMark.js';
import { Csat } from '../src/components/Csat.js';
import { PrivacyLink } from '../src/components/PrivacyLink.js';
import { ratedKey, readRated, sendRating } from '../src/csat.js';
import { initI18n } from '../src/i18n.js';
import { applyTheme, DEFAULT_LOOK, isDefaultLook, themeVariables } from '../src/theme.js';

/** The brand's look in the chat (W03): colour and corners, logo, rating and privacy link. */

beforeAll(async () => {
  await initI18n('en');
});

describe('the brand’s colour and corners', () => {
  it('changes nothing for a brand that kept Hamnivo’s own look', () => {
    expect(isDefaultLook(DEFAULT_LOOK)).toBe(true);
    const style = new Map<string, string>();
    applyTheme(
      {
        style: {
          setProperty: (name, value) => style.set(name, value),
          removeProperty: (name) => style.delete(name),
        },
      },
      DEFAULT_LOOK,
    );
    expect(style.size).toBe(0);
  });

  it('sets the tokens the chat is drawn from, and takes them off for the default look again', () => {
    const style = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => style.set(name, value),
        removeProperty: (name: string) => style.delete(name),
      },
    };
    applyTheme(root, { accent: '#0B5D3B', onAccent: '#FFFFFF', radius: 4 });
    expect(style.get('--hv-primary')).toBe('#0B5D3B');
    expect(style.get('--hv-on-primary')).toBe('#FFFFFF');
    expect(style.get('--hv-radius-lg')).toBe('4px');
    applyTheme(root, DEFAULT_LOOK);
    expect(style.size).toBe(0);
  });

  it('keeps the design’s proportions as corners get rounder or square', () => {
    const at = (radius: number) =>
      themeVariables({ accent: '#0B5D3B', onAccent: '#FFFFFF', radius });
    expect(at(12)).toMatchObject({
      '--hv-radius-sm': '6px',
      '--hv-radius-md': '8px',
      '--hv-radius-lg': '12px',
      '--hv-radius-xl': '16px',
    });
    expect(at(24)).toMatchObject({ '--hv-radius-sm': '12px', '--hv-radius-xl': '32px' });
    expect(at(0)).toMatchObject({ '--hv-radius-sm': '0px', '--hv-radius-xl': '0px' });
  });

  it('moves the hover colour towards white on a dark colour and towards black on a light one', () => {
    const hover = (accent: string, onAccent: string) =>
      themeVariables({ accent, onAccent, radius: 12 })['--hv-primary-hover'];
    expect(hover('#000000', '#FFFFFF')).toBe('#1F1F1F');
    expect(hover('#D17B00', '#192A30')).toBe('#B86C00');
  });
});

describe('the rating', () => {
  const API = 'https://api.test';
  function clientWith(responder: (path: string, body: unknown) => Response | Promise<Response>) {
    const calls: { path: string; body: unknown }[] = [];
    const client = new HamnivoClient({
      apiBase: API,
      widgetId: 'wid_test',
      storage: new MemoryStorage(),
      fetch: (async (url: string, init?: RequestInit) => {
        const path = url.replace(API, '');
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (path === '/v1/widget/sessions') {
          return Response.json(
            {
              accessToken: 'a',
              accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
              refreshToken: 'ses_x.r',
              principal: { id: 'cus_1', verified: false, displayName: null },
              config: {},
              conversations: [],
            },
            { status: 201 },
          );
        }
        calls.push({ path, body });
        return responder(path, body);
      }) as typeof fetch,
    });
    return { client, calls };
  }

  it('sends the rating and the comment, then remembers it on this device', async () => {
    const { client, calls } = clientWith(() => new Response(null, { status: 204 }));
    await sendRating(client, 'conv_1', 4, '  Quick and kind  ');
    expect(calls).toEqual([
      {
        path: '/v1/widget/conversations/conv_1/feedback',
        body: { rating: 4, comment: 'Quick and kind' },
      },
    ]);
    expect(readRated(client.storage, ratedKey('wid_test', 'conv_1'))).toBe(4);
    expect(readRated(client.storage, ratedKey('wid_test', 'conv_2'))).toBeNull();
  });

  it('leaves out an empty comment, and does not remember a rating that was not sent', async () => {
    const ok = clientWith(() => new Response(null, { status: 204 }));
    await sendRating(ok.client, 'conv_1', 5, '   ');
    expect(ok.calls[0]?.body).toEqual({ rating: 5 });

    const failing = clientWith(() =>
      Response.json(
        { status: 500, code: 'INTERNAL', retryable: true, title: 'x' },
        { status: 500 },
      ),
    );
    await expect(sendRating(failing.client, 'conv_1', 3, '')).rejects.toBeDefined();
    expect(readRated(failing.client.storage, ratedKey('wid_test', 'conv_1'))).toBeNull();
  });

  it('ignores anything stored that is not a rating from 1 to 5', () => {
    const storage = new MemoryStorage();
    for (const value of ['0', '6', 'x', '2.5', '']) {
      storage.setItem('k', value);
      expect(readRated(storage, 'k'), value).toBeNull();
    }
  });

  const render = (client: HamnivoClient) =>
    renderToString(
      <AnnouncerProvider>
        <Csat client={client} conversationId="conv_1" />
      </AnnouncerProvider>,
    );

  it('asks with five stars a keyboard can reach, and an optional comment', () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));
    const html = render(client);
    expect(html).toContain('How was this chat?');
    for (const n of [1, 2, 3, 4, 5]) {
      expect(html).toContain(`aria-label="${n} out of 5"`);
    }
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html).toContain('Anything to add? (optional)');
    expect(html).toContain('Choose a rating first.');
  });

  it('says thank you instead of asking again once this device has rated', () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));
    client.storage.setItem(ratedKey('wid_test', 'conv_1'), '5');
    const html = render(client);
    expect(html).toContain('Thank you for your feedback.');
    expect(html).not.toContain('type="radio"');
  });
});

describe('the logo and the privacy link', () => {
  it('shows a logo as decoration when the brand has one, and nothing when it has none', () => {
    const html = renderToString(<BrandMark url="https://cdn.noor.example/logo.png" />);
    expect(html).toContain('src="https://cdn.noor.example/logo.png"');
    expect(html).toContain('alt=""');
    // The page that loads the logo is not told which website the customer was on.
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(renderToString(<BrandMark url={null} />)).toBe('');
  });

  it('links the privacy policy in a new tab, and only a web address', () => {
    const html = renderToString(<PrivacyLink url="https://noor.example/privacy" />);
    expect(html).toContain('href="https://noor.example/privacy"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('Privacy policy');
    expect(renderToString(<PrivacyLink url={null} />)).toBe('');
    expect(renderToString(<PrivacyLink url="javascript:alert(1)" />)).toBe('');
    expect(renderToString(<PrivacyLink url="not a url" />)).toBe('');
  });
});
