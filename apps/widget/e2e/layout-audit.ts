/**
 * Layout audit (no database): the built widget and loader on host pages in every layout mode,
 * against a mocked gateway, at a matrix of screen sizes and languages. Writes a screenshot per
 * case and a JSON report of measurable problems (horizontal overflow, controls outside the
 * visible area, small tap targets, the chat frame leaving the screen).
 *
 *   pnpm --filter @hamnivo/widget-loader build && pnpm --filter @hamnivo/widget exec vite build
 *   node apps/widget/e2e/layout-audit.ts <outDir>
 *
 * CHECK=api checks the website's side instead (Hamnivo.on, prefill, hide…), and CHECK=live how a
 * reply arrives: the sign that one is on its way, what the assistant is doing, the answer while
 * it is written, and its place taken by the published message. Both throw on the first thing
 * that is wrong. ONLY=<regex> runs the matching cases of the matrix, and SCALE=2 takes its
 * screenshots at twice the size.
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
type Scenario = 'home' | 'conversation' | 'waiting' | 'rich';

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

/** An answer with everything an answer can carry: a table, code, sources and what to ask next. */
const RICH_ANSWER = [
  '### Delivery options',
  '',
  '| Option | Arrives in | Cost | Tracking |',
  '|---|---|---|---|',
  '| Standard | 5–7 working days | Free over $35 | Yes |',
  '| Express | 1–2 working days | $9.90 | Yes, live |',
  '| International | 7–14 working days | From $14.50 | Depends on the carrier |',
  '',
  'Orders placed before **2 pm** ship the same day [1]. A damaged book can be returned within 30 days [2].',
  '',
  '### Track an order from your own system',
  '',
  '```bash',
  'curl https://api.noorbooks.example.com/v1/orders/NB-2026-0000918273645/tracking \\',
  '  -H "Authorization: Bearer $NOOR_API_KEY"',
  '```',
  '',
  '- The reply lists every parcel',
  '- `status` is one of `packed`, `shipped` or `delivered`',
].join('\n');

const richParts = [
  { type: 'text', text: RICH_ANSWER, format: 'markdown' },
  {
    type: 'source',
    sourceId: 'src_1',
    title: 'Delivery times and costs',
    url: 'https://noorbooks.example.com/help/delivery',
    version: '3',
    excerpt: 'Orders placed before 2 pm on a working day leave our warehouse the same day.',
    freshness: 'current',
  },
  {
    type: 'source',
    sourceId: 'src_2',
    title: 'Returns and refunds for damaged or missing items',
    url: 'https://noorbooks.example.com/help/returns',
    version: '7',
    excerpt: 'A damaged book can be returned within 30 days of delivery for a replacement.',
    freshness: 'stale',
  },
  {
    type: 'suggestions',
    items: ['Do you deliver to Germany?', 'Where is my order?', 'Change my delivery address'],
  },
];

function messages(sc: Scenario = scenario) {
  if (sc === 'rich') {
    const rich = [
      [me, text('What are the delivery options, and can I track an order from my own system?')],
      [ai, richParts],
    ] as const;
    return rich.map(([sender, parts], index) => ({
      id: `msg_${index + 1}`,
      conversationId: 'cnv_layout1',
      sequence: index + 1,
      sender,
      visibility: 'public',
      parts,
      createdAt: at(index + 1),
      clientMessageId: sender.kind === 'customer' ? '00000000-0000-4000-8000-000000000000' : null,
      delivery: sender.kind === 'customer' ? 'read' : null,
      language: 'en',
    }));
  }
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
  } else if (path === '/v1/widget/conversations/cnv_layout1/messages' && request.method === 'GET') {
    const items = messages();
    json({ items, olderCursor: null, latestSequence: items.length });
  } else if (path.endsWith('/events')) {
    // Held open with no events, like a quiet conversation.
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.write(': open\n\n');
    streams.add(response);
    request.on('close', () => streams.delete(response));
  } else if (path === '/__push') {
    pushed += 1;
    const message = {
      ...messages('conversation')[4],
      id: `msg_${pushed}`,
      sequence: pushed,
      createdAt: at(30),
    };
    const event = { type: 'message.created', sequence: pushed, data: { message } };
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    json({ streams: streams.size });
  } else if (path === '/__event') {
    // Any event a check wants the gateway to have sent, as given.
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      for (const stream of streams) stream.write(`data: ${body}\n\n`);
      json({ streams: streams.size });
    });
  } else if (/\/messages$/.test(path) && request.method === 'POST') {
    // The visitor's own message, accepted as the gateway would.
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const sent = JSON.parse(body || '{}') as {
        clientMessageId?: string;
        parts?: Array<{ text?: string }>;
      };
      pushed += 1;
      const message = {
        id: `msg_${pushed}`,
        conversationId: 'cnv_layout1',
        sequence: pushed,
        sender: me,
        visibility: 'public',
        parts: text(sent.parts?.[0]?.text ?? ''),
        createdAt: new Date().toISOString(),
        clientMessageId: sent.clientMessageId ?? null,
        delivery: 'sent',
        language: 'en',
      };
      const event = { type: 'message.created', sequence: pushed, data: { message } };
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
      json({ message, conversation: conversation('conversation') }, 201);
    });
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
const SCENARIOS: Scenario[] = ['home', 'conversation', 'waiting', 'rich'];

async function runCase(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  sc: Scenario,
  mode: string,
  viewport: [string, number, number],
  lang: string,
): Promise<Problem[]> {
  const [, width, height] = viewport;
  const context = await browser.newContext({
    viewport: { width, height },
    locale: lang,
    // SCALE=2 for screenshots people will look at; measurements are the same either way.
    deviceScaleFactor: Number(process.env.SCALE ?? 1),
  });
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

/**
 * How a reply arrives (CHECK=live), with the events a gateway that streams would send: the sign
 * that a reply is on its way as soon as the visitor has written, what the assistant is doing,
 * the answer while it is written (never counted as a message), and the published message in its
 * place. Then the menu and Escape, reading earlier messages while new ones arrive, and the dark
 * chat. Screenshots at twice the size go to <outDir>/live. Throws on the first thing wrong.
 */
async function checkLive(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const dir = join(outDir, 'live');
  mkdirSync(dir, { recursive: true });
  const fail = (what: string) => {
    throw new Error(`live check: ${what}`);
  };
  const send = (event: unknown) =>
    fetch(`${origin(ports.api)}/__event`, { method: 'POST', body: JSON.stringify(event) });
  const live = (type: string, data: Record<string, unknown>) =>
    send({ type, sequence: null, data: { conversationId: 'cnv_layout1', ...data } });
  const activity = (kind: string, state: 'started' | 'finished') =>
    live('activity', { runId: 'run_1', kind, state, label: null });

  scenario = 'conversation';
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`${origin(ports.host)}/bubble?lang=en`);
  await page.locator('[data-hamnivo-launcher]').click();
  const frame = page.frameLocator('iframe[data-hamnivo-frame]');
  const shot = (name: string) => page.screenshot({ path: join(dir, `${name}.png`) });
  await frame.locator('[data-sender]').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  const replies = () => frame.locator('[data-sender="ai_primary"]').count();
  const before = await replies();

  // 1. The visitor writes: a reply is on its way, without a word from the gateway yet.
  const box = frame.locator('textarea[aria-label]');
  await box.fill('Can it arrive before Friday?');
  await box.press('Enter');
  await frame.getByTestId('ai-writing').waitFor({ timeout: 5_000 });
  if ((await box.inputValue()) !== '') fail('the message box kept the sent words');
  if (await box.isDisabled()) fail('the message box is closed while a reply is on its way');
  await shot('1-reply-on-its-way');

  // 2. What the assistant is doing, in words.
  await activity('run', 'started');
  await activity('searching', 'started');
  const step = frame.getByTestId('run-step');
  await step.waitFor({ timeout: 5_000 });
  if ((await step.innerText()) !== 'Searching the help articles…')
    fail(`the step says "${await step.innerText()}"`);
  await shot('2-searching');
  await activity('searching', 'finished');

  // 3. The answer while it is written: on screen, marked as not final, and not a message.
  const pieces = [
    'Yes. **Express** delivery ',
    'takes 1–2 working days, ',
    'so an order placed today ',
    'arrives by Thursday.\n\n',
    '- Cost: $9.90\n',
    '- Order before **2 pm**',
  ];
  for (const [index, textDelta] of pieces.entries()) {
    await live('message.delta', { runId: 'run_1', draftId: 'drf_1', index, textDelta });
    if (index === 2) {
      await frame.getByTestId('draft-reply').waitFor({ timeout: 5_000 });
      await shot('3-writing');
    }
  }
  const draft = frame.getByTestId('draft-reply');
  await frame.getByText('Order before').waitFor({ timeout: 5_000 });
  if (await frame.getByTestId('ai-writing').count()) fail('dots stayed beside the draft');
  if ((await replies()) !== before) fail('a draft was counted as a reply');
  if ((await draft.getAttribute('data-state')) !== 'provisional') fail('the draft is not marked');
  if (!(await draft.locator('strong').count())) fail('the draft is not shown as formatted text');
  await shot('4-written');

  // 4. Published: the message takes the draft's place, once.
  pushed += 1;
  await send({
    type: 'message.created',
    sequence: pushed,
    data: {
      draftId: 'drf_1',
      message: {
        id: `msg_${pushed}`,
        conversationId: 'cnv_layout1',
        sequence: pushed,
        sender: ai,
        visibility: 'public',
        parts: [
          ...text(pieces.join(''), 'markdown'),
          { type: 'suggestions', items: ['What does Express cost abroad?', 'Change my address'] },
        ],
        createdAt: new Date().toISOString(),
        clientMessageId: null,
        delivery: null,
        language: 'en',
      },
    },
  });
  await activity('run', 'finished');
  await frame.getByTestId('follow-ups').waitFor({ timeout: 5_000 });
  if (await draft.count()) fail('the draft stayed after its reply was published');
  if (await frame.getByTestId('ai-writing').count()) fail('dots stayed after the reply');
  if ((await replies()) !== before + 1) fail(`replies went from ${before} to ${await replies()}`);
  await page.waitForTimeout(500);
  await shot('5-published');

  // 5. The menu closes with Escape and the chat stays; Escape again closes the chat.
  await frame.getByRole('button', { name: 'More options' }).click();
  await frame.getByTestId('more-menu').waitFor({ timeout: 2_000 });
  await page.waitForTimeout(350);
  await shot('6-menu');
  await page.keyboard.press('Escape');
  await frame.getByTestId('more-menu').waitFor({ state: 'detached', timeout: 2_000 });
  const chat = page.locator('iframe[data-hamnivo-frame]');
  if (!(await chat.isVisible())) fail('Escape closed the chat together with its menu');

  // The emoji go where the caret is; Escape puts them away and gives focus back, chat open.
  const emojiButton = frame.getByRole('button', { name: 'Add an emoji' });
  await emojiButton.click();
  const emoji = frame.getByRole('group', { name: 'Add an emoji' });
  await emoji.waitFor({ timeout: 5_000 });
  await page.waitForTimeout(350);
  await shot('6b-emoji');
  await emoji.getByRole('button').nth(1).click();
  if ((await box.inputValue()) !== '😊') fail(`the emoji went in as "${await box.inputValue()}"`);
  await page.keyboard.press('Escape');
  await emoji.waitFor({ state: 'detached', timeout: 2_000 });
  if (!(await chat.isVisible())) fail('Escape closed the chat together with the emoji');
  if (!(await emojiButton.evaluate((el) => el === document.activeElement)))
    fail('focus did not go back to the emoji button');
  await box.fill('');

  // 6. Reading earlier messages: a new reply does not move the page, and says it is there.
  const thread = frame.getByTestId('thread');
  await thread.evaluate((el) => el.scrollTo({ top: 0 }));
  await frame.getByTestId('jump-latest').waitFor({ timeout: 3_000 });
  await fetch(`${origin(ports.api)}/__push`, { method: 'POST' });
  const jump = frame.getByTestId('jump-new');
  await jump.waitFor({ timeout: 5_000 });
  if ((await jump.innerText()) !== 'New messages: 1') fail(`jump says "${await jump.innerText()}"`);
  if ((await thread.evaluate((el) => el.scrollTop)) > 4) fail('a new reply moved the page');
  await shot('7-new-while-reading');
  await jump.click();
  await jump.waitFor({ state: 'detached', timeout: 5_000 });
  await page.keyboard.press('Escape');
  await chat.waitFor({ state: 'hidden', timeout: 3_000 });
  await context.close();

  // 7. The long answer, and the same on a phone and in the dark chat.
  scenario = 'rich';
  for (const [name, width, height, query] of [
    ['8-rich', 1280, 800, ''],
    ['9-rich-phone', 390, 844, ''],
    ['10-rich-dark', 390, 844, '&theme=dark'],
  ] as const) {
    const view = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const direct = await view.newPage();
    await direct.goto(
      `${origin(ports.widget)}/?widgetId=${WIDGET_ID}&api=${encodeURIComponent(origin(ports.api))}${query}`,
    );
    await direct.locator('.hv-table').waitFor({ timeout: 15_000 });
    await direct.waitForTimeout(600);
    const theme = await direct.evaluate(() => document.documentElement.dataset.theme);
    if (theme !== (query ? 'dark' : 'light')) fail(`${name}: the chat is ${theme}`);
    const wide = await direct.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (wide) fail(`${name}: the long answer makes the chat scroll sideways`);
    if (!(await direct.locator('[data-hv-copy]').count())) fail(`${name}: code has no copy button`);
    if ((await direct.getByTestId('sources').locator('li').count()) !== 2)
      fail(`${name}: sources are not listed`);
    await direct.screenshot({ path: join(dir, `${name}.png`) });
    await view.close();
  }
  process.stdout.write(
    '✓ live check: reply on its way, steps, draft, published, menu, reading, long answer, dark\n',
  );
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
  if (process.env.CHECK === 'api' || process.env.CHECK === 'live') {
    try {
      await (process.env.CHECK === 'api' ? checkApi : checkLive)(browser);
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
          // The long answer where it is narrowest (the bubble) and widest (the full page).
          if (sc === 'rich' && (lang !== 'en' || mode === 'panel' || mode === 'inline')) continue;
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
