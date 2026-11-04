/**
 * Layout audit (no database): the built widget and loader on host pages in every layout mode,
 * against a mocked gateway, at a matrix of screen sizes and languages. Writes a screenshot per
 * case and a JSON report of measurable problems (horizontal overflow, controls outside the
 * visible area, small tap targets, the chat frame leaving the screen).
 *
 *   pnpm --filter @hamnivo/widget-loader build && pnpm --filter @hamnivo/widget exec vite build
 *   node apps/widget/e2e/layout-audit.ts <outDir>
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WidgetSession } from '@hamnivo/contracts';
import { chromium, type Frame, type Page } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../..');
const outDir = resolve(process.argv[2] ?? join(root, 'apps/widget/test-results/layout'));
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const ports = { host: 5290, api: 5291, widget: 5292 };
const origin = (port: number) => `http://127.0.0.1:${port}`;
const WIDGET_ID = 'wid_layoutaudit';
const now = new Date('2026-11-04T10:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
};

function serveFile(response: ServerResponse, file: string) {
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}

// ---------------------------------------------------------------- fixtures
type Scenario = 'home' | 'conversation' | 'waiting';

const conversation = (scenario: Scenario) => ({
  id: 'cnv_layout1',
  status: scenario === 'waiting' ? 'waiting_for_person' : 'open',
  responder: scenario === 'waiting' ? 'none' : 'ai',
  createdAt: at(0),
  updatedAt: at(9),
  unreadCount: 0,
  lastMessagePreview: 'You can return any book within 30 days.',
  latestSequence: 6,
  ticket: null,
  canReturnToAssistant: scenario === 'waiting',
});

const ai = {
  kind: 'ai_agent',
  id: 'prt_ai',
  displayName: 'Noor Assistant',
  roleLabel: 'AI assistant',
};
const person = {
  kind: 'human_agent',
  id: 'prt_h',
  displayName: 'Aisha Rahman',
  roleLabel: 'Support',
};
const me = { kind: 'customer', id: 'prt_c', displayName: 'You' };
const text = (value: string, format: 'plain' | 'markdown' = 'plain') => [
  { type: 'text', text: value, format },
];

function messages() {
  const items = [
    [
      me,
      text(
        'Assalamu alaikum, I ordered two books last week and one arrived damaged. Can I return it?',
      ),
    ],
    [
      ai,
      text(
        'Wa alaikum assalam! Yes — damaged books can be returned within **30 days**.\n\n1. Open your order page\n2. Choose *Return an item*\n3. Print the label\n\nFull policy: https://noorbooks.example.com/help/returns-and-refunds-policy-for-damaged-or-missing-items',
        'markdown',
      ),
    ],
    [
      me,
      text(
        'Order number is NB-2026-0000918273645 and the tracking ref is 1Z999AA10123456784XYZLONGREFERENCE',
      ),
    ],
    [ai, text('Thanks. I found order NB-2026-0000918273645. A replacement can ship today.')],
    [
      person,
      text(
        'Hi, this is Aisha from the support team. I can approve a refund instead if you prefer.',
      ),
    ],
    [me, text('A replacement is perfect, thank you!')],
  ] as const;
  return items.map(([sender, parts], index) => ({
    id: `msg_${index + 1}`,
    conversationId: 'cnv_layout1',
    sequence: index + 1,
    sender,
    visibility: 'public',
    parts,
    createdAt: at(index + 1),
    clientMessageId:
      sender.kind === 'customer' ? `00000000-0000-4000-8000-00000000000${index}` : null,
    delivery: sender.kind === 'customer' ? 'read' : null,
    language: 'en',
  }));
}

const everyLocale = (value: string) => ({ en: value, ar: value, hi: value, ur: value });

function session(scenario: Scenario) {
  return WidgetSession.parse({
    accessToken: 'test-access',
    accessTokenExpiresAt: at(60),
    refreshToken: 'test-refresh',
    principal: { id: 'prn_layout', verified: false, displayName: null },
    config: {
      widgetId: WIDGET_ID,
      version: 1,
      brand: {
        name: 'Noor Books',
        logoUrl: null,
        accent: '#0F5132',
        onAccent: '#FFFFFF',
        radius: 12,
        launcherPosition: 'bottom-right',
      },
      locales: { default: 'en', available: ['en', 'ar', 'hi', 'ur'] },
      copy: Object.fromEntries(
        ['en', 'ar', 'hi', 'ur'].map((l) => [
          l,
          {
            greeting:
              l === 'ar'
                ? 'مرحبًا! كيف يمكننا مساعدتك اليوم؟'
                : 'Hi! How can we help you today? Ask about orders, returns or books.',
            aiDisclosure:
              'Answers may come from an AI assistant. You can ask for a person at any time.',
            offlineMessage: 'We are away right now. Leave a message and we will reply by email.',
            privacyNotice: null,
          },
        ]),
      ),
      availability: {
        humanAvailable: true,
        nextOpenAt: null,
        timezone: 'Asia/Dubai',
        staffOnline: true,
        hoursSet: true,
        open: true,
      },
      features: {
        attachments: true,
        helpCenter: true,
        csat: true,
        voice: false,
        identityRequiredForHistory: false,
      },
      privacyPolicyUrl: 'https://noorbooks.example.com/privacy',
      attachmentLimits: { maxBytes: 10_000_000, allowedMimeTypes: ['image/png'], maxFiles: 5 },
      layout: { mode: 'bubble', position: 'bottom-right' },
      help: {
        suggestions: {
          en: [
            'Where is my order?',
            'How do I return a damaged book?',
            'Do you ship internationally?',
          ],
          ar: ['أين طلبي؟', 'كيف أعيد كتابًا تالفًا؟', 'هل تشحنون دوليًا؟'],
          hi: [],
          ur: [],
        },
        search: true,
      },
      messageDeletion: { windowSeconds: 300 },
      notifications: { email: false },
      proactive: { triggers: [] },
      forms: {
        prechat: { enabled: false, skipVerified: true, fields: [] },
        offline: { enabled: false, when: 'either', fields: [], thanks: everyLocale('Thanks') },
      },
      consent: { required: false, given: true, noticeVersion: 0, text: everyLocale('') },
      direct: false,
      chatAvailable: true,
    },
    conversations: scenario === 'home' ? [] : [conversation(scenario)],
  });
}

// ---------------------------------------------------------------- servers
const unmocked = new Set<string>();
let scenario: Scenario = 'home';
/** Open event streams, so a check can push a reply as the gateway would. */
const streams = new Set<ServerResponse>();
let pushed = 6;

function api(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://x');
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') {
    response.end();
    return;
  }
  const json = (body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const path = url.pathname;
  if (path === '/v1/widget/sessions' || path === '/v1/widget/sessions/refresh') {
    json(session(scenario));
  } else if (path === '/v1/widget/conversations/cnv_layout1/messages') {
    json({ items: messages(), olderCursor: null, latestSequence: 6 });
  } else if (path.endsWith('/events')) {
    // Held open with no events, like a quiet conversation.
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.write(': open\n\n');
    streams.add(response);
    request.on('close', () => streams.delete(response));
  } else if (path === '/__push') {
    pushed += 1;
    const message = { ...messages()[4], id: `msg_${pushed}`, sequence: pushed, createdAt: at(30) };
    const event = { type: 'message.created', sequence: pushed, data: { message } };
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    json({ streams: streams.size });
  } else if (path === '/v1/widget/conversations') {
    json({ items: scenario === 'home' ? [] : [conversation(scenario)] });
  } else {
    unmocked.add(`${request.method} ${path}`);
    json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  }
}

function host(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    response.end('ok');
    return;
  }
  const mode = url.pathname.slice(1) || 'bubble';
  const lang = url.searchParams.get('lang') ?? 'en';
  const container =
    mode === 'inline'
      ? '<section style="max-width:720px;margin:24px auto;padding:0 16px"><h2>Chat with us</h2><div id="chat"></div></section>'
      : '';
  const filler = Array.from(
    { length: 30 },
    (_, i) =>
      `<p>Paragraph ${i + 1}: Noor Books sells Islamic and Arabic literature worldwide.</p>`,
  ).join('');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Noor Books</title>
<style>body{margin:0;font-family:Georgia,serif;background:#f6f3ee;color:#222}header{background:#0F5132;color:#fff;padding:16px}main{padding:16px}</style></head>
<body><header><strong>Noor Books</strong></header><main><h1>Bestsellers</h1>${container}${filler}</main>
<script src="${origin(ports.widget)}/loader.js" data-widget-id="${WIDGET_ID}" data-api="${origin(ports.api)}" data-mode="${mode}" data-locale="${lang}" ${mode === 'inline' ? 'data-container="#chat"' : ''} async></script></body></html>`);
}

function widget(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://x');
  if (url.pathname === '/loader.js') {
    serveFile(response, join(root, 'packages/widget-loader/dist/loader.js'));
    return;
  }
  const dist = join(root, 'apps/widget/dist');
  const file = normalize(join(dist, url.pathname));
  const inside = file.startsWith(dist) && existsSync(file) && statSync(file).isFile();
  serveFile(response, inside ? file : join(dist, 'index.html'));
}

// ---------------------------------------------------------------- measurements
interface Problem {
  kind: string;
  detail: string;
}

/** Problems inside the chat frame, measured in the frame's own document. */
async function measureFrame(frame: Frame): Promise<Problem[]> {
  return frame.evaluate(() => {
    const problems: { kind: string; detail: string }[] = [];
    const doc = document.documentElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (doc.scrollWidth > vw + 1)
      problems.push({
        kind: 'h-overflow',
        detail: `document ${doc.scrollWidth}px wide in ${vw}px`,
      });
    const describe = (el: Element) => {
      const label =
        el.getAttribute('aria-label') ??
        (el as HTMLElement).innerText?.trim().slice(0, 40) ??
        el.tagName;
      const testId = el.getAttribute('data-testid');
      return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ''} "${label}"`;
    };
    const interactive = Array.from(
      document.querySelectorAll('button, a[href], input, textarea, select, [role="button"]'),
    ).filter((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // Visually hidden helpers (sr-only, file inputs behind a button) are not targets.
      return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 1 && r.height > 1;
    });
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1)
        problems.push({
          kind: 'offscreen-x',
          detail: `${describe(el)} spans ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}`,
        });
      if ((r.width < 24 || r.height < 24) && el.tagName !== 'A')
        problems.push({
          kind: 'small-target',
          detail: `${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`,
        });
    }
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const s = getComputedStyle(el);
      const hidden = s.overflowX === 'hidden' || s.overflowX === 'clip';
      if (
        hidden &&
        el.clientWidth > 1 &&
        el.scrollWidth > el.clientWidth + 2 &&
        s.textOverflow !== 'ellipsis'
      )
        problems.push({
          kind: 'clipped',
          detail: `${describe(el)} ${el.scrollWidth}>${el.clientWidth}`,
        });
    }
    const composer = document.querySelector('textarea');
    if (composer) {
      const r = composer.getBoundingClientRect();
      if (r.bottom > vh + 1)
        problems.push({ kind: 'composer-below', detail: `bottom ${Math.round(r.bottom)} > ${vh}` });
    }
    const log = document.querySelector('.overflow-y-auto[tabindex="0"]');
    if (log) {
      const r = log.getBoundingClientRect();
      if (r.height < 160)
        problems.push({
          kind: 'thread-cramped',
          detail: `message area ${Math.round(r.height)}px tall of ${vh}`,
        });
    }
    return problems;
  });
}

/** The frame on the host page: on screen, tall enough, not covered by the launcher. */
async function measureHost(page: Page): Promise<Problem[]> {
  return page.evaluate(() => {
    const problems: { kind: string; detail: string }[] = [];
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-hamnivo-frame]');
    if (!frame) return [{ kind: 'no-frame', detail: 'chat frame not found' }];
    const r = frame.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1)
      problems.push({
        kind: 'frame-offscreen',
        detail: `frame ${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}×${vh}`,
      });
    // Short only if the screen had more room to give it.
    if (r.height < Math.min(420, vh - 8) && getComputedStyle(frame).position === 'fixed')
      problems.push({
        kind: 'frame-short',
        detail: `frame ${Math.round(r.height)}px tall in ${vh}px viewport`,
      });
    const launcher = document.querySelector<HTMLElement>('[data-hamnivo-launcher]');
    if (launcher && r.width > 0) {
      const l = launcher.getBoundingClientRect();
      const overlaps = l.left < r.right && l.right > r.left && l.top < r.bottom && l.bottom > r.top;
      const onTop =
        document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2) === launcher;
      if (overlaps && onTop)
        problems.push({ kind: 'launcher-over-chat', detail: 'launcher covers the open chat' });
    }
    return problems;
  });
}

// ---------------------------------------------------------------- matrix
// Real devices and windows, smallest first. 640x360 is a 1280x720 laptop at 200 % zoom.
const VIEWPORTS: Array<[string, number, number]> = [
  ['280x653-fold', 280, 653],
  ['320x568', 320, 568],
  ['360x800-android', 360, 800],
  ['375x667', 375, 667],
  ['390x844', 390, 844],
  ['412x915-pixel', 412, 915],
  ['430x932', 430, 932],
  ['568x320-landscape', 568, 320],
  ['640x360-zoom200', 640, 360],
  ['744x1133-ipadmini', 744, 1133],
  ['768x1024', 768, 1024],
  ['820x1180-ipadair', 820, 1180],
  ['844x390-landscape', 844, 390],
  ['1024x768', 1024, 768],
  ['1024x1366-ipadpro', 1024, 1366],
  ['1280x600-short', 1280, 600],
  ['1366x768-laptop', 1366, 768],
  ['1440x900', 1440, 900],
  ['1920x1080', 1920, 1080],
  ['2560x1440', 2560, 1440],
];
const MODES = ['bubble', 'panel', 'inline', 'fullpage'] as const;
const SCENARIOS: Scenario[] = ['home', 'conversation', 'waiting'];

async function runCase(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  sc: Scenario,
  mode: string,
  viewport: [string, number, number],
  lang: string,
): Promise<Problem[]> {
  const [, width, height] = viewport;
  const context = await browser.newContext({ viewport: { width, height }, locale: lang });
  const page = await context.newPage();
  const problems: Problem[] = [];
  try {
    await page.goto(`${origin(ports.host)}/${mode}?lang=${lang}`);
    if (mode === 'bubble' || mode === 'panel') {
      await page.locator('[data-hamnivo-launcher]').click({ timeout: 10_000 });
    }
    const frameEl = page.locator('iframe[data-hamnivo-frame]');
    await frameEl.waitFor({ timeout: 10_000 });
    const frame = (await (await frameEl.elementHandle())?.contentFrame()) ?? null;
    if (!frame) throw new Error('no frame');
    await frame.waitForSelector(sc === 'home' ? 'textarea' : '[data-sender]', { timeout: 15_000 });
    // An inline chat sits in the page: look at it where the visitor would scroll to it.
    if (mode === 'inline') await frameEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    problems.push(...(await measureHost(page)), ...(await measureFrame(frame)));
  } catch (error) {
    problems.push({ kind: 'error', detail: String((error as Error).message).split('\n')[0] ?? '' });
  }
  await page.screenshot({ path: join(outDir, `${sc}-${mode}-${viewport[0]}-${lang}.png`) });
  await context.close();
  return problems;
}

/**
 * The website's side (CHECK=api): a reply while the chat is closed shows a preview, counts in the
 * tab's title and reaches Hamnivo.on('message') without its words; then prefill, setLocale,
 * hide, show and getState. Throws on the first thing that is wrong.
 */
async function checkApi(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  scenario = 'conversation';
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const fail = (what: string) => {
    throw new Error(`api check: ${what}`);
  };
  await page.goto(`${origin(ports.host)}/bubble?lang=en`);
  await page.evaluate(() => {
    const w = window as unknown as {
      events: unknown[];
      Hamnivo: { on(e: string, l: (p: unknown) => void): void };
    };
    w.events = [];
    for (const name of ['message', 'unread', 'conversation.started', 'open', 'close'])
      w.Hamnivo.on(name, (payload) => w.events.push([name, payload]));
  });
  await page.locator('[data-hamnivo-launcher]').click();
  const frame = page.frameLocator('iframe[data-hamnivo-frame]');
  await frame.locator('[data-sender]').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => (window as unknown as { Hamnivo: { close(): void } }).Hamnivo.close());
  const pushedTo = await (await fetch(`${origin(ports.api)}/__push`, { method: 'POST' })).json();
  if (!(pushedTo as { streams: number }).streams) fail('no open event stream to push to');
  const preview = page.locator('[data-hamnivo-reply]');
  await preview.waitFor({ timeout: 10_000 });
  const words = await preview.innerText();
  if (!words.includes('New reply from Aisha Rahman')) fail(`preview says "${words}"`);
  if (words.includes('approve a refund')) fail('preview shows the message itself');
  await page.screenshot({ path: join(outDir, 'api-reply-preview.png') });
  const title = await page.title();
  if (!title.startsWith('(1) ')) fail(`title is "${title}"`);
  const events = (await page.evaluate(
    () => (window as unknown as { events: [string, Record<string, unknown>][] }).events,
  )) as [string, Record<string, unknown>][];
  const message = events.find(([name]) => name === 'message');
  if (message?.[1].from !== 'person') fail(`events ${JSON.stringify(events)}`);
  if (JSON.stringify(events).includes('approve a refund')) fail('an event carries message text');
  if (events.some(([name]) => name === 'conversation.started'))
    fail('an existing conversation was reported as started');

  await page.evaluate(() =>
    (window as unknown as { Hamnivo: { prefill(t: string): void } }).Hamnivo.prefill(
      'About order #1042',
    ),
  );
  const box = frame.locator('textarea[aria-label]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, 'api-prefill.png') });
  await box.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.title.startsWith('Noor Books'), null, {
    timeout: 5_000,
  });
  if ((await box.inputValue()) !== 'About order #1042') fail('prefill did not fill the box');
  if (await preview.count()) fail('preview stayed after opening the chat');

  await page.evaluate(() =>
    (window as unknown as { Hamnivo: { setLocale(l: string): void } }).Hamnivo.setLocale('ar'),
  );
  await frame.locator('html[dir="rtl"]').waitFor({ timeout: 5_000 });

  const state = () =>
    page.evaluate(() =>
      (
        window as unknown as { Hamnivo: { getState(): Record<string, unknown> } }
      ).Hamnivo.getState(),
    );
  if ((await state()).open !== true) fail('getState().open is not true');
  await page.evaluate(() => (window as unknown as { Hamnivo: { hide(): void } }).Hamnivo.hide());
  await page.waitForTimeout(200);
  const hidden = await state();
  if (hidden.hidden !== true || hidden.open !== false) fail(`after hide ${JSON.stringify(hidden)}`);
  if (await page.locator('[data-hamnivo-launcher]').isVisible()) fail('launcher still visible');
  await page.evaluate(() => (window as unknown as { Hamnivo: { show(): void } }).Hamnivo.show());
  await page.locator('[data-hamnivo-launcher]').waitFor({ state: 'visible', timeout: 2_000 });
  process.stdout.write('✓ api check: preview, title, events, prefill, setLocale, hide, show\n');
  await page.close();
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const servers = [
    createServer(api).listen(ports.api),
    createServer(host).listen(ports.host),
    createServer(widget).listen(ports.widget),
  ];
  // The installed Google Chrome when Playwright's own browser is not downloaded (CHANNEL=chrome).
  const browser = await chromium.launch(
    process.env.CHANNEL ? { channel: process.env.CHANNEL } : {},
  );
  if (process.env.CHECK === 'api') {
    try {
      await checkApi(browser);
    } finally {
      await browser.close();
      for (const server of servers) server.close();
      for (const stream of streams) stream.end();
    }
    return;
  }
  const report: Array<{ id: string; problems: Problem[] }> = [];
  for (const sc of SCENARIOS) {
    scenario = sc;
    for (const mode of MODES) {
      for (const viewport of VIEWPORTS) {
        for (const lang of ['en', 'ar']) {
          // Arabic for the conversation only, and the waiting banner in the bubble only.
          if (lang === 'ar' && sc !== 'conversation') continue;
          if (mode !== 'bubble' && sc === 'waiting') continue;
          const id = `${sc}-${mode}-${viewport[0]}-${lang}`;
          if (only && !only.test(id)) continue;
          const problems = await runCase(browser, sc, mode, viewport, lang);
          report.push({ id, problems });
          const kinds = problems.map((p) => p.kind).join(', ');
          process.stdout.write(`${problems.length ? '✗' : '✓'} ${id} ${kinds}\n`);
        }
      }
    }
  }
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify({ report, unmocked: [...unmocked] }, null, 2),
  );
  process.stdout.write(`unmocked: ${[...unmocked].join(' | ') || 'none'}\n`);
  await browser.close();
  for (const server of servers) server.close();
}

await main();
