import { ATTACHMENT_TYPES, type AutomationDefinition, WidgetSettings } from '@hamnivo/contracts';
import { type schema, toPublicId } from '@hamnivo/db';
import type { AuthorityAttachment, AuthorityMessage } from '@hamnivo/domain';
import { describe, expect, it } from 'vitest';
import {
  attachmentParts,
  attachmentPublicId,
  isDeleted,
  reactionOf,
} from '../src/authority/extended-parts.js';
import { firstName, type StaffFace, shownName } from '../src/authority/staff-faces.js';
import { contractMessage } from '../src/authority/views.js';
import type { AppConfig } from '../src/config.js';
import { cleanFileName, filesScannable, sniff } from '../src/widget/attachments.service.js';
import { DEFAULT_SURFACE, launcherConfig, widgetConfig } from '../src/widget/copy.js';
import { transcriptLine } from '../src/widget/customer-emails.service.js';
import { excerptOf } from '../src/widget/help.service.js';
import { escapeHtml, maskEmail, UnsubscribeTokens } from '../src/widget/notifications.service.js';
import { NOTIFY_COPY } from '../src/widget/notifications-copy.js';
import type { BrandSurface } from '../src/widget/settings.service.js';
import { attachmentScanner } from '../src/widget/surface.module.js';
import { previewOf } from '../src/widget/views.js';

const MESSAGE_ID = toPublicId('message', '0191b0f0-0000-7000-8000-000000000041');

function message(overrides: Partial<AuthorityMessage> = {}): AuthorityMessage {
  return {
    ref: '41',
    conversationRef: '7',
    key: null,
    direction: 'outgoing',
    private: false,
    text: 'Hello',
    contentAttributes: {},
    sender: { kind: 'user', ref: '3', name: 'Sara' },
    attachments: [],
    createdAt: new Date('2026-10-02T10:00:00Z'),
    ...overrides,
  } as AuthorityMessage;
}

function file(overrides: Partial<AuthorityAttachment> = {}): AuthorityAttachment {
  return {
    ref: '9',
    fileType: 'file',
    url: 'http://chatwoot.local/rails/active_storage/blobs/redirect/abc/label.pdf',
    size: 2048,
    name: 'label.pdf',
    mimeType: 'application/pdf',
    ...overrides,
  };
}

const view = (m: AuthorityMessage) =>
  contractMessage({
    message: m,
    id: MESSAGE_ID,
    conversationId: toPublicId('conversation', '0191b0f0-0000-7000-8000-000000000042'),
    sequence: null,
    clientMessageId: null,
    delivery: null,
  });

describe('file names and types (W09)', () => {
  it('keeps only a safe name, with the extension of the type found in the bytes', () => {
    expect(cleanFileName('../../etc/passwd.PDF', 'image/png')).toBe('passwd.png');
    expect(cleanFileName('C:\\Users\\me\\scan.jpeg', 'image/jpeg')).toBe('scan.jpg');
    // Direction overrides would make "evil‮fdp.exe" read as "evilexe.pdf".
    expect(cleanFileName('evil\u202efdp.exe', 'application/pdf')).toBe('evilfdp.pdf');
    expect(cleanFileName('...', 'image/gif')).toBe('file.gif');
    expect(cleanFileName(`${'x'.repeat(300)}.png`, 'image/png')).toHaveLength(124);
  });

  it('reads the type from the bytes, never from the name', async () => {
    expect(await sniff(Buffer.from('%PDF-1.7\n%%EOF'))).toBe('application/pdf');
    // Pictures that can carry scripts, programs and plain text are never an allowed type.
    const allowed: readonly (string | null)[] = ATTACHMENT_TYPES;
    expect(allowed).not.toContain(
      await sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    );
    expect(allowed).not.toContain(
      await sniff(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)])),
    );
    expect(await sniff(Buffer.from('plain words'))).toBeNull();
  });

  it('offers files only where they can be scanned, and refuses every file otherwise', async () => {
    const production = { NODE_ENV: 'production', CLAMAV_URL: undefined } as AppConfig;
    expect(filesScannable(production)).toBe(false);
    expect(filesScannable({ ...production, CLAMAV_URL: 'tcp://clamav:3310' })).toBe(true);
    expect(filesScannable({ ...production, NODE_ENV: 'development' })).toBe(true);
    const verdict = await attachmentScanner(production).scan(Buffer.from('%PDF-1.7'));
    expect(verdict).toMatchObject({ clean: false, reason: 'scan_unavailable' });
    const dev = attachmentScanner({ ...production, NODE_ENV: 'test' });
    expect(await dev.scan(Buffer.from('%PDF-1.7'))).toMatchObject({ clean: true });
  });
});

describe('message parts from the authority (W09, W22–W24)', () => {
  it('names files by an id derived from the message, never by their address', () => {
    const parts = attachmentParts(message({ attachments: [file()] }), MESSAGE_ID);
    expect(parts).toEqual([
      {
        type: 'attachment',
        uploadId: attachmentPublicId(MESSAGE_ID, '9'),
        name: 'label.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        status: 'available',
      },
    ]);
    expect(JSON.stringify(parts)).not.toContain('active_storage');
    expect(attachmentPublicId(MESSAGE_ID, '9')).toBe(attachmentPublicId(MESSAGE_ID, '9'));
    expect(attachmentPublicId(MESSAGE_ID, '9')).not.toBe(attachmentPublicId(MESSAGE_ID, '10'));
  });

  it('shows shared places and contacts, and falls back to text when they are not valid', () => {
    const place = file({
      fileType: 'location',
      coordinates: { latitude: 24.8607, longitude: 67.0011 },
      fallbackTitle: 'Clifton Block 5',
      url: null,
    });
    const person = file({
      fileType: 'contact',
      fallbackTitle: '+92 300 1234567',
      meta: { firstName: 'Bilal', lastName: 'Ahmed', email: 'bilal@example.com' },
      url: null,
    });
    const nowhere = file({
      fileType: 'location',
      coordinates: { latitude: 200, longitude: 0 },
      fallbackTitle: 'Somewhere',
      url: null,
    });
    const nameless = file({ fileType: 'contact', fallbackTitle: null, meta: {}, url: null });
    expect(
      attachmentParts(message({ attachments: [place, person, nowhere, nameless] }), MESSAGE_ID),
    ).toEqual([
      { type: 'location', latitude: 24.8607, longitude: 67.0011, label: 'Clifton Block 5' },
      {
        type: 'contact',
        name: 'Bilal Ahmed',
        phone: '+92 300 1234567',
        email: 'bilal@example.com',
      },
      { type: 'unknown', originalType: 'location', fallbackText: 'Somewhere' },
      { type: 'unknown', originalType: 'contact', fallbackText: null },
    ]);
  });

  it('reads a reaction only from a customer message Hamnivo wrote, with an offered emoji', () => {
    const reaction = { hv: { v: 1, reaction: { emoji: '👍', messageId: MESSAGE_ID } } };
    expect(
      reactionOf(message({ direction: 'incoming', text: '👍', contentAttributes: reaction })),
    ).toEqual({ type: 'reaction', emoji: '👍', messageId: MESSAGE_ID });
    // From staff, or with an emoji that is not offered, it is an ordinary message.
    expect(reactionOf(message({ text: '👍', contentAttributes: reaction }))).toBeNull();
    const fire = { hv: { v: 1, reaction: { emoji: '🔥', messageId: MESSAGE_ID } } };
    expect(reactionOf(message({ direction: 'incoming', contentAttributes: fire }))).toBeNull();
  });

  it('keeps a deleted message’s place and author, and nothing of what it said', () => {
    const deleted = message({
      text: 'This message was deleted',
      contentAttributes: { deleted: true },
      attachments: [file()],
    });
    expect(isDeleted(deleted)).toBe(true);
    expect(view(deleted)).toMatchObject({
      id: MESSAGE_ID,
      sender: { kind: 'human_agent', displayName: 'Sara' },
      parts: [{ type: 'notice', notice: 'message_deleted', text: 'This message was deleted.' }],
    });
  });

  it('shows customers a teammate by first name and photo; staff by the full name', () => {
    const staffView = (m: AuthorityMessage, staff: ReadonlyMap<string, StaffFace>) =>
      contractMessage({
        message: m,
        id: MESSAGE_ID,
        conversationId: toPublicId('conversation', '0191b0f0-0000-7000-8000-000000000042'),
        sequence: null,
        clientMessageId: null,
        delivery: null,
        staff,
      });
    const full = message({ sender: { kind: 'user', ref: '3', name: 'Sara Khan' } });
    const faces = new Map([['3', { name: 'Sara', photoUrl: 'https://cdn.example/sara.jpg' }]]);
    expect(staffView(full, faces).sender).toEqual({
      kind: 'human_agent',
      displayName: 'Sara',
      roleLabel: 'Support agent',
      avatarUrl: 'https://cdn.example/sara.jpg',
    });
    // A Chatwoot user Hamnivo does not know: the first word only, no photo.
    expect(staffView(full, new Map()).sender).toEqual({
      kind: 'human_agent',
      displayName: 'Sara',
      roleLabel: 'Support agent',
    });
    expect(
      staffView(message({ sender: { kind: 'user', ref: '3', name: null } }), new Map()).sender
        .displayName,
    ).toBe('Support agent');
    // The assistant and the customer are untouched; staff views keep the full name.
    expect(
      staffView(message({ sender: { kind: 'bot', ref: '3', name: 'Noor Helper' } }), faces).sender
        .displayName,
    ).toBe('Noor Helper');
    expect(view(full).sender.displayName).toBe('Sara Khan');
    expect(shownName({ displayName: 'Sara Khan', publicName: null })).toBe('Sara');
    expect(shownName({ displayName: 'Sara Khan', publicName: '  Sally ' })).toBe('Sally');
    expect(firstName('   ')).toBe('Team');
  });

  it('shows a file sent without words as the file alone', () => {
    const parts = view(message({ text: null, attachments: [file()] })).parts;
    expect(parts.map((p) => p.type)).toEqual(['attachment']);
    expect(view(message({ text: null })).parts).toEqual([
      { type: 'text', text: '[empty message]', format: 'plain' },
    ]);
  });
});

describe('previews and emails (W05, W25)', () => {
  it('previews the words, else what was shared', () => {
    expect(previewOf([{ type: 'text', text: 'Hi', format: 'plain' }])).toBe('Hi');
    expect(
      previewOf([
        {
          type: 'attachment',
          uploadId: 'upl_01j9zk7w3xq8r4t2v6m5n1p0cd',
          name: 'a.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          status: 'available',
        },
      ]),
    ).toBe('📎 a.png');
    expect(previewOf([{ type: 'location', latitude: 1.5, longitude: 2.25, label: null }])).toBe(
      '📍 1.5000, 2.2500',
    );
    expect(previewOf([{ type: 'reaction', emoji: '❤️', messageId: MESSAGE_ID }])).toBe('❤️');
    expect(previewOf([])).toBeNull();
  });

  it('writes transcript lines that name files and places instead of attaching them', () => {
    const line = transcriptLine(
      {
        ...view(
          message({
            text: null,
            attachments: [
              file(),
              file({ fileType: 'location', coordinates: { latitude: 1, longitude: 2 }, url: null }),
            ],
          }),
        ),
      },
      NOTIFY_COPY.en,
      '2 Oct 2026, 10:00',
    );
    expect(line).toBe(
      '2 Oct 2026, 10:00 — Sara (Support agent): [File: label.pdf]\n[Place: (1.00000, 2.00000)]',
    );
  });

  it('hides most of an address, and escapes what it puts in a page', () => {
    expect(maskEmail('amina@example.com')).toBe('a•••@example.com');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('signs unsubscribe links so they cannot be altered or widened', () => {
    const tokens = new UnsubscribeTokens({ kek: { key: Buffer.alloc(32, 7) } } as AppConfig);
    const token = tokens.sign({ t: 'tenant', p: 'principal', k: 'transcript' });
    expect(tokens.verify(token)).toEqual({ t: 'tenant', p: 'principal', k: 'transcript' });
    const [payload, mac] = token.split('.');
    const widened = Buffer.from(JSON.stringify({ t: 'tenant', p: 'principal', k: 'all' })).toString(
      'base64url',
    );
    expect(tokens.verify(`${widened}.${mac}`)).toBeNull();
    expect(tokens.verify(`${payload}.${'A'.repeat(43)}`)).toBeNull();
    expect(tokens.verify(`${payload}`)).toBeNull();
    const otherKey = new UnsubscribeTokens({ kek: { key: Buffer.alloc(32, 8) } } as AppConfig);
    expect(otherKey.verify(token)).toBeNull();
  });

  it('refuses another spelling of the same signature', () => {
    const tokens = new UnsubscribeTokens({ kek: { key: Buffer.alloc(32, 7) } } as AppConfig);
    const claims = { t: 'tenant', p: 'principal', k: 'transcript' } as const;
    const [payload, mac] = tokens.sign(claims).split('.') as [string, string];
    // The last of the 43 characters carries four bits and two spare ones, which decoding skips:
    // four spellings are the same 32 bytes, and only the one the gateway wrote may verify.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const spellings = [...alphabet].filter((c) =>
      Buffer.from(`${mac.slice(0, -1)}${c}`, 'base64url').equals(Buffer.from(mac, 'base64url')),
    );
    expect(spellings).toHaveLength(4);
    for (const c of spellings) {
      const verified = tokens.verify(`${payload}.${mac.slice(0, -1)}${c}`);
      expect(verified).toEqual(c === mac.slice(-1) ? claims : null);
    }
  });

  it('shortens help passages at a word', () => {
    expect(excerptOf('short  text\n here')).toBe('short text here');
    const long = `${'word '.repeat(200)}end`;
    const excerpt = excerptOf(long, 50);
    expect(excerpt.length).toBeLessThanOrEqual(50);
    expect(excerpt.endsWith('word…')).toBe(true);
  });
});

describe('the widget’s and the loader’s configuration (W02, W19)', () => {
  const brand = {
    id: '0191b0f0-0000-7000-8000-000000000001',
    tenantId: '0191b0f0-0000-7000-8000-000000000002',
    workspaceId: '0191b0f0-0000-7000-8000-000000000003',
    name: 'Coral Bazaar',
    widgetPublicId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0cd',
    allowedOrigins: ['https://coral.example'],
    theme: {},
    businessHours: {
      timezone: 'Asia/Karachi',
      weekly: {
        sun: [],
        mon: [{ open: '09:00', close: '17:00' }],
        tue: [{ open: '09:00', close: '17:00' }],
        wed: [{ open: '09:00', close: '17:00' }],
        thu: [{ open: '09:00', close: '17:00' }],
        fri: [{ open: '09:00', close: '17:00' }],
        sat: [],
      },
      closedDates: [],
    },
    configVersion: 4,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.brands.$inferSelect;
  const pricing: AutomationDefinition = {
    event: { type: 'page_view', seconds: 30 },
    match: 'all',
    conditions: [{ field: 'page_url', op: 'starts_with', value: '/pricing' }],
    actions: [{ type: 'show_prompt', message: { en: 'Questions?', ar: 'أسئلة؟' } }],
  };
  const prompt = (definition: AutomationDefinition) => ({
    id: '0191b0f0-0000-7000-8000-0000000000aa',
    publicId: 'aut_01j9zk7w3xq8r4t2v6m5n1p0aa',
    brandId: brand.id,
    name: 'Pricing help',
    versionId: '0191b0f0-0000-7000-8000-0000000000ab',
    version: 1,
    definition,
  });
  const surface = (definitions: AutomationDefinition[] = [pricing]): BrandSurface => ({
    ...DEFAULT_SURFACE,
    settings: WidgetSettings.parse({ layout: { mode: 'inline' } }),
    prompts: definitions.map(prompt),
  });
  // Friday 2 October 2026: 11:00 and 20:00 in Karachi.
  const working = new Date('2026-10-02T06:00:00Z');
  const evening = new Date('2026-10-02T15:00:00Z');

  it('gives the widget every published prompt’s words, by automation, in every language', () => {
    expect(widgetConfig(brand, evening, surface()).proactive.triggers).toEqual([
      {
        id: 'aut_01j9zk7w3xq8r4t2v6m5n1p0aa',
        message: { en: 'Questions?', ar: 'أسئلة؟', hi: 'Questions?', ur: 'Questions?' },
      },
    ]);
    expect(widgetConfig(brand, evening, surface([])).proactive.triggers).toEqual([]);
  });

  it('checks what the gateway knows and leaves the page to the loader', () => {
    expect(launcherConfig(brand, surface(), 'ar', evening).proactive).toEqual({
      enabled: true,
      maxPerDay: 1,
      dismissHours: 24,
      triggers: [],
      rules: [
        {
          id: 'aut_01j9zk7w3xq8r4t2v6m5n1p0aa',
          seconds: 30,
          any: false,
          when: [['page_url', 'starts_with', '/pricing']],
          message: 'أسئلة؟',
        },
      ],
    });
    // Only while people work: decided here, by the brand's hours.
    const onlyWorking = surface([
      {
        ...pricing,
        conditions: [...pricing.conditions, { field: 'hours_open', op: 'is', value: true }],
      },
    ]);
    expect(launcherConfig(brand, onlyWorking, 'en', working).proactive.rules).toHaveLength(1);
    expect(launcherConfig(brand, onlyWorking, 'en', evening).proactive).toMatchObject({
      enabled: false,
      rules: [],
    });
    // By country, from the request; an unknown country never matches.
    const gulf = surface([
      { ...pricing, conditions: [{ field: 'country', op: 'is', value: ['AE', 'SA'] }] },
    ]);
    expect(
      launcherConfig(brand, gulf, 'en', working, { country: 'AE' }).proactive.rules[0]?.when,
    ).toEqual([]);
    expect(launcherConfig(brand, gulf, 'en', working, { country: 'DE' }).proactive.rules).toEqual(
      [],
    );
    expect(launcherConfig(brand, gulf, 'en', working).proactive.rules).toEqual([]);
  });

  it('gives the loader its layout and labels in the visitor’s language', () => {
    const config = launcherConfig(brand, surface(), 'ur', working);
    expect(config).toMatchObject({
      version: 4,
      locale: 'ur',
      dir: 'rtl',
      layout: { mode: 'inline', position: 'bottom-right' },
      launcher: { accent: '#192A30', onAccent: '#FFFFFF', openLabel: 'چیٹ کھولیں' },
    });
    expect(launcherConfig(brand, surface(), 'fr', working).locale).toBe('en');
  });

  it('does not offer files where they cannot be scanned', () => {
    expect(widgetConfig(brand, working, surface()).features.attachments).toBe(true);
    expect(
      widgetConfig(brand, working, surface(), { filesScannable: false }).features.attachments,
    ).toBe(false);
  });
});
