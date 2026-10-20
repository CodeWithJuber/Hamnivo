import type { WidgetConfig } from '@hamnivo/contracts';
import { WidgetAppearance } from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { previewConfig, previewTextColour, readPreview } from '../src/preview.js';

const appearance = WidgetAppearance.parse({
  primaryColor: '#0B5D3B',
  greeting: { en: 'Hello', ar: 'مرحبا' },
  fontFamily: 'system',
  showBranding: false,
});
const parent = {} as Window;
const event = (change: Partial<MessageEvent> = {}) =>
  ({
    source: parent,
    origin: 'https://studio.example',
    data: { source: 'hamnivo-studio-preview', appearance },
    ...change,
  }) as MessageEvent;
describe('real renderer draft preview', () => {
  it('accepts only schema-valid drafts in the test iframe from its own parent origin', () => {
    expect(readPreview(event(), parent, 'https://studio.example', true)).toEqual(appearance);
    expect(readPreview(event(), parent, 'https://studio.example', false)).toBeNull();
    expect(
      readPreview(
        event({ origin: 'https://other.example' }),
        parent,
        'https://studio.example',
        true,
      ),
    ).toBeNull();
    expect(
      readPreview(event({ source: {} as Window }), parent, 'https://studio.example', true),
    ).toBeNull();
    expect(
      readPreview(
        event({ data: { source: 'hamnivo-studio-preview', appearance: { primaryColor: 'red' } } }),
        parent,
        'https://studio.example',
        true,
      ),
    ).toBeNull();
  });
  it('uses readable text for a draft colour', () => {
    expect(previewTextColour('#000000')).toBe('#FFFFFF');
    expect(previewTextColour('#FFFFFF')).toBe('#192A30');
  });
  it('overlays presentation while preserving permissions and session configuration', () => {
    const config = {
      brand: { name: 'Noor' },
      copy: Object.fromEntries(
        ['en', 'ar', 'hi', 'ur'].map((locale) => [
          locale,
          {
            greeting: 'Original',
            offlineMessage: 'Away',
            aiDisclosure: 'AI assistant',
            privacyNotice: null,
          },
        ]),
      ),
      features: { csat: false, attachments: true },
      privacyPolicyUrl: null,
      chatAvailable: false,
    } as WidgetConfig;
    const next = previewConfig(config, appearance);
    expect(next.brand).toMatchObject({
      accent: '#0B5D3B',
      fontFamily: 'system',
      showBranding: false,
    });
    expect(next.copy.hi.greeting).toBe('Hello');
    expect(next.copy.ar.greeting).toBe('مرحبا');
    expect(next.copy.en.aiDisclosure).toBe('AI assistant');
    expect(next.chatAvailable).toBe(false);
    expect(next.features.attachments).toBe(true);
    expect(config.copy.en.greeting).toBe('Original');
  });
});
