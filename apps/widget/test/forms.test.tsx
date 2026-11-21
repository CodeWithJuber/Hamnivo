import { HamnivoApiError, HamnivoClient, MemoryStorage } from '@hamnivo/client';
import type {
  CustomerConversation,
  OfflineMessageResponse,
  WidgetConfig,
  WidgetFormField,
} from '@hamnivo/contracts';
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import i18next from 'i18next';
import { renderToString } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { availabilityOf, backAt, offlineFormApplies } from '../src/availability.js';
import { ChatForm } from '../src/components/ChatForm.js';
import { ContactForm, TicketThanks } from '../src/components/ContactForm.js';
import { Conversations } from '../src/components/Conversations.js';
import { Csat } from '../src/components/Csat.js';
import { Home } from '../src/components/Home.js';
import { StartGate } from '../src/components/StartGate.js';
import { StatusLine } from '../src/components/StatusLine.js';
import { directWidgetId, noIndex } from '../src/direct.js';
import {
  answersOf,
  consentNeeded,
  firstMessageOf,
  isConsentRequired,
  isEmail,
  labelOf,
  prechatNeeded,
  prefill,
  serverProblems,
  validateFields,
} from '../src/forms.js';
import { ensureLocale, initI18n } from '../src/i18n.js';
import { ticketWords } from '../src/tickets.js';

/**
 * Who can answer (W11), the brand's forms and consent (W11, W26, W27), tickets (H19), reopening
 * (W15) and the direct chat link (W28): the rules, and the screens rendered to HTML.
 */

beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await i18next.changeLanguage('en');
});

type Availability = WidgetConfig['availability'];
const availability = (overrides: Partial<Availability> = {}): Availability => ({
  humanAvailable: false,
  nextOpenAt: null,
  timezone: 'Asia/Dubai',
  staffOnline: false,
  hoursSet: false,
  open: false,
  ...overrides,
});

const text = (en: string) => ({ en, ar: `${en} (ar)`, hi: `${en} (hi)`, ur: `${en} (ur)` });
const field = (
  id: string,
  kind: WidgetFormField['kind'],
  required = false,
  options: string[] = [],
): WidgetFormField => ({
  id,
  kind,
  label: text(id === 'email' ? 'Your email' : `Label ${id}`),
  required,
  options: options.map((o) => ({ id: o, label: text(`Option ${o}`) })),
});

const OFFLINE_FIELDS = [
  field('name', 'name'),
  field('email', 'email', true),
  field('question', 'question', true),
];

function config(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    privacyPolicyUrl: 'https://noor.example/privacy',
    availability: availability(),
    forms: {
      prechat: { enabled: false, skipVerified: true, fields: [field('name', 'name', true)] },
      offline: {
        enabled: true,
        when: 'either',
        fields: OFFLINE_FIELDS,
        thanks: text('Thanks, we read every message.'),
      },
    },
    consent: { required: false, given: false, noticeVersion: 1, text: text('We keep this chat.') },
    ...overrides,
  } as WidgetConfig;
}

describe('who can answer (W11)', () => {
  it('says a person is online, busy, away until a time, or that nobody is', () => {
    expect(availabilityOf(availability({ staffOnline: true, open: true }))).toEqual({
      kind: 'online',
    });
    // Online people come first, even outside business hours.
    expect(availabilityOf(availability({ staffOnline: true, hoursSet: true }))).toEqual({
      kind: 'online',
    });
    expect(availabilityOf(availability({ hoursSet: true, open: true }))).toEqual({ kind: 'busy' });
    expect(
      availabilityOf(availability({ hoursSet: true, nextOpenAt: '2026-10-12T05:00:00Z' })),
    ).toEqual({ kind: 'away', until: '2026-10-12T05:00:00Z' });
    // Without hours, or without a time to name, nobody is promised.
    expect(availabilityOf(availability({ nextOpenAt: '2026-10-12T05:00:00Z' }))).toEqual({
      kind: 'nobody',
    });
    expect(availabilityOf(availability({ hoursSet: true }))).toEqual({ kind: 'nobody' });
    expect(availabilityOf(availability({ hoursSet: true, nextOpenAt: 'soon' }))).toEqual({
      kind: 'nobody',
    });
  });

  it('names the time people are back in the brand’s time zone', () => {
    const at = '2026-10-12T05:00:00Z';
    const expected = new Intl.DateTimeFormat('en', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Dubai',
      timeZoneName: 'short',
    }).format(new Date(at));
    expect(backAt(at, 'en', 'Asia/Dubai')).toBe(expected);
    expect(backAt(at, 'en', 'Asia/Dubai')).toContain('9:00');
    // A time zone the browser does not know still gives a time, never an error.
    expect(backAt(at, 'en', 'Mars/Olympus_Mons')).toMatch(/\d/);
  });

  it('says it in words with an icon, in every state', () => {
    const html = (a: Availability) =>
      renderToString(<StatusLine availability={a} locale="en" />).replaceAll('&#x27;', '’');
    expect(html(availability({ staffOnline: true }))).toContain(
      'We’re online. A person can join this chat.',
    );
    expect(html(availability({ open: true, hoursSet: true }))).toContain(
      'We’re here, but busy. A person will answer as soon as they can.',
    );
    expect(html(availability({ hoursSet: true, nextOpenAt: '2026-10-12T05:00:00Z' }))).toContain(
      `We’re away until ${backAt('2026-10-12T05:00:00Z', 'en', 'Asia/Dubai')}.`,
    );
    const nobody = html(availability());
    expect(nobody).toContain('Nobody is online right now. Your message will wait for a person.');
    expect(nobody).toContain('data-state="nobody"');
    expect(nobody).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
});

describe('when the contact form replaces waiting (W11)', () => {
  const applies = (when: 'closed' | 'nobody_online' | 'either', a: Partial<Availability>) =>
    offlineFormApplies(
      config({
        availability: availability(a),
        forms: { ...config().forms, offline: { ...config().forms.offline, when } },
      }),
    );

  it('follows the brand’s choice: outside business hours, nobody online, or either', () => {
    // Outside the hours, with someone online anyway.
    const closedButOnline = { hoursSet: true, open: false, staffOnline: true };
    expect(applies('closed', closedButOnline)).toBe(true);
    expect(applies('either', closedButOnline)).toBe(true);
    expect(applies('nobody_online', closedButOnline)).toBe(false);
    // Inside the hours, with nobody online.
    const openNobody = { hoursSet: true, open: true, staffOnline: false };
    expect(applies('closed', openNobody)).toBe(false);
    expect(applies('nobody_online', openNobody)).toBe(true);
    expect(applies('either', openNobody)).toBe(true);
    // No hours set: "closed" cannot be said; nobody online still can.
    expect(applies('closed', { hoursSet: false, staffOnline: false })).toBe(false);
    expect(applies('either', { hoursSet: false, staffOnline: false })).toBe(true);
    // Someone online inside the hours: people answer in the chat.
    for (const when of ['closed', 'nobody_online', 'either'] as const) {
      expect(applies(when, { hoursSet: true, open: true, staffOnline: true })).toBe(false);
    }
  });

  it('never applies when the brand turned it off, or the configuration has no forms', () => {
    const off = config();
    off.forms.offline.enabled = false;
    expect(offlineFormApplies(off)).toBe(false);
    expect(offlineFormApplies({ availability: availability() } as unknown as WidgetConfig)).toBe(
      false,
    );
  });
});

describe('the brand’s forms (W11, W26)', () => {
  const fields = [
    field('name', 'name', true),
    field('email', 'email'),
    field('phone', 'phone'),
    field('team', 'department', true, ['sales', 'billing']),
    field('question', 'question'),
  ];

  it('names missing answers, addresses that are not addresses, and unknown choices', () => {
    expect(validateFields(fields, {})).toEqual({ name: 'missing', team: 'missing' });
    expect(validateFields(fields, { name: '   ', team: 'sales' })).toEqual({ name: 'missing' });
    expect(
      validateFields(fields, { name: 'Amina', team: 'support', email: 'amina@example' }),
    ).toEqual({ team: 'invalid', email: 'email' });
    // An optional address may stay empty.
    expect(validateFields(fields, { name: 'Amina', team: 'billing' })).toEqual({});
    expect(isEmail(' amina@example.com ')).toBe(true);
    for (const bad of ['amina', 'amina@', '@example.com', 'a b@example.com', 'amina@example']) {
      expect(isEmail(bad), bad).toBe(false);
    }
  });

  it('sends only the form’s own answers, trimmed, and only those given', () => {
    expect(
      answersOf(fields, {
        name: ' Amina ',
        email: '',
        team: 'billing',
        extra: 'x',
        question: 'Hi',
      }),
    ).toEqual({ name: 'Amina', team: 'billing', question: 'Hi' });
  });

  it('shows on its field what the gateway refused', () => {
    const refused = new HamnivoApiError(422, 'VALIDATION_FAILED', false, null, {
      fields: [
        { path: 'prechat.email', message: 'Invalid email' },
        { path: 'answers.team', message: 'Unknown team' },
        { path: 'firstMessage', message: 'Too long' },
      ],
    });
    expect(serverProblems(refused, fields)).toEqual({ email: 'email', team: 'invalid' });
    expect(serverProblems(new HamnivoApiError(503, 'X', true, null), fields)).toEqual({});
    expect(serverProblems(new Error('offline'), fields)).toEqual({});
  });

  it('starts the question with what the visitor wrote, and sends the question as written', () => {
    expect(prefill(fields, 'Where is my order?')).toEqual({ question: 'Where is my order?' });
    expect(prefill(fields, '')).toEqual({});
    expect(prefill([field('name', 'name')], 'Hi')).toEqual({});
    expect(firstMessageOf(fields, { question: 'Where is order 1042?' }, 'Where is my order?')).toBe(
      'Where is order 1042?',
    );
    expect(firstMessageOf(fields, { question: '' }, 'Where is my order?')).toBe(
      'Where is my order?',
    );
    expect(firstMessageOf([field('name', 'name')], { name: 'Amina' }, 'Hello')).toBe('Hello');
    expect(firstMessageOf([field('name', 'name')], { name: 'Amina' }, '')).toBeUndefined();
  });

  it('asks the pre-chat form unless it is off or the signed-in customer may go straight in', () => {
    const on = config();
    on.forms.prechat.enabled = true;
    const anonymous = { id: 'cus_1', verified: false, displayName: null };
    const verified = { ...anonymous, verified: true };
    expect(prechatNeeded({ config: on, principal: anonymous })).toBe(true);
    expect(prechatNeeded({ config: on, principal: verified })).toBe(false);
    on.forms.prechat.skipVerified = false;
    expect(prechatNeeded({ config: on, principal: verified })).toBe(true);
    expect(prechatNeeded({ config: config(), principal: anonymous })).toBe(false);
  });

  it('asks for consent only when the brand asks and the visitor has not agreed (W27)', () => {
    const asks = (required: boolean, given: boolean) =>
      consentNeeded({ consent: { required, given, noticeVersion: 2, text: text('x') } });
    expect(asks(true, false)).toBe(true);
    expect(asks(true, true)).toBe(false);
    expect(asks(false, false)).toBe(false);
    expect(isConsentRequired(new HamnivoApiError(403, 'CONSENT_REQUIRED', false, null))).toBe(true);
    expect(isConsentRequired(new HamnivoApiError(422, 'VALIDATION_FAILED', false, null))).toBe(
      false,
    );
  });

  it('reads labels in the visitor’s language, English filling gaps', () => {
    expect(labelOf({ en: 'Name', ar: 'الاسم' }, 'ar')).toBe('الاسم');
    expect(labelOf({ en: 'Name', ar: '' }, 'ar')).toBe('Name');
    expect(labelOf({ en: 'Name' }, 'ur')).toBe('Name');
  });

  it('asks each kind of answer with the right keyboard, autofill and label', () => {
    const html = renderToString(
      <ChatForm
        id="f"
        fields={fields}
        locale="en"
        consent={{ text: 'We keep this chat for 30 days.', privacyPolicyUrl: 'https://p.example' }}
        submit="Start chat"
        failed="Failed"
        onSubmit={async () => undefined}
      />,
    );
    expect(html).toMatch(/<input[^>]*id="f-name"[^>]*type="text"[^>]*autoComplete="name"/);
    expect(html).toMatch(
      /aria-required="true"[^>]*id="f-name"|id="f-name"[^>]*aria-required="true"/,
    );
    expect(html).toMatch(/type="email"[^>]*autoComplete="email"[^>]*inputMode="email"/);
    expect(html).toMatch(/type="tel"[^>]*autoComplete="tel"/);
    expect(html).toMatch(/<textarea[^>]*id="f-question"/);
    // A list is a group of radio buttons named by its legend.
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Label team<span[^>]*> \(required\)<\/span>/);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain('<label for="f-name"');
    expect(html).toContain(
      'Label name<span class="font-normal text-text-muted"> (required)</span>',
    );
    // Consent: the words, the privacy policy, and a box never ticked in advance.
    expect(html).toContain('We keep this chat for 30 days.');
    expect(html).toContain('href="https://p.example"');
    expect(html).toMatch(/<input[^>]*id="f-consent"[^>]*type="checkbox"/);
    expect(html).not.toMatch(/id="f-consent"[^>]*checked/);
    expect(html).toContain('I agree');
    expect(html).toContain('noValidate');
  });
});

describe('before the chat starts (W26, W27)', () => {
  const render = (props: Partial<Parameters<typeof StartGate>[0]>) =>
    renderToString(
      <StartGate
        fields={[]}
        consent={null}
        pending=""
        remembered={{}}
        locale="en"
        onSubmit={async () => undefined}
        onConsentRequired={async () => undefined}
        onValues={() => undefined}
        onCancel={() => undefined}
        {...props}
      />,
    );

  it('asks the pre-chat form with the visitor’s message in the question', () => {
    const html = render({
      fields: [field('name', 'name', true), field('question', 'question', true)],
      pending: 'Where is my order?',
    });
    expect(html).toContain('Before we start');
    expect(html).toContain('data-testid="prechat"');
    expect(html).toMatch(/<textarea[^>]*>Where is my order\?<\/textarea>/);
    expect(html).toContain('Start chat');
    expect(html).toContain('Not now');
    expect(html).not.toContain('data-testid="pending-message"');
  });

  it('shows the waiting message when the form asks no question, and remembers answers', () => {
    const html = render({
      fields: [field('name', 'name', true)],
      pending: 'Hello there',
      remembered: { name: 'Amina' },
    });
    expect(html).toContain('Your message');
    expect(html).toContain('Hello there');
    expect(html).toMatch(/id="[^"]*-name"[^>]*value="Amina"|value="Amina"[^>]*id="[^"]*-name"/);
  });

  it('asks for consent alone in a compact card that continues', () => {
    const html = render({
      consent: { text: 'We keep this chat.', privacyPolicyUrl: null },
      pending: 'Hi',
    });
    expect(html).toContain('data-testid="consent-card"');
    expect(html).toContain('We keep this chat.');
    expect(html).toContain('Continue');
    expect(html).not.toContain('Start chat');
    expect(html).not.toContain('Privacy policy');
  });
});

describe('the home screen and the contact form (W11)', () => {
  const client = new HamnivoClient({
    apiBase: 'https://api.test',
    widgetId: 'wid_test',
    storage: new MemoryStorage(),
  });

  it('says who can answer under the greeting, and offers to leave a message', () => {
    const html = renderToString(
      <Home
        client={client}
        greeting="Hello! Ask us anything."
        prompt={null}
        suggestions={['Where is my order?']}
        search={false}
        availability={availability()}
        locale="en"
        onContact={() => undefined}
        onAsk={() => undefined}
        disclosure="I'm Noor Books's AI assistant."
      />,
    ).replaceAll('&#x27;', '’');
    const greeting = html.indexOf('Hello! Ask us anything.');
    const status = html.indexOf('Nobody is online right now.');
    const card = html.indexOf('Nobody can answer right now');
    expect(greeting).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(greeting);
    expect(card).toBeGreaterThan(status);
    expect(html).toContain('Leave a message and we’ll answer by email.');
    expect(html).toContain('Leave a message</button>');
    // The questions stay: the assistant may still answer.
    expect(html).toContain('Where is my order?');
  });

  it('shows no card while someone can answer', () => {
    const html = renderToString(
      <Home
        client={client}
        greeting="Hello"
        prompt={null}
        suggestions={[]}
        search={false}
        availability={availability({ staffOnline: true })}
        locale="en"
        onContact={null}
        onAsk={() => undefined}
        disclosure="I'm Noor Books's AI assistant."
      />,
    );
    expect(html).not.toContain('contact-card');
    expect(html).toContain('data-state="online"');
  });

  it('asks the brand’s fields, with consent when the visitor must agree first', () => {
    const asks = config({
      consent: { required: true, given: false, noticeVersion: 4, text: text('We keep it.') },
    });
    const html = renderToString(
      <ContactForm
        config={asks}
        locale="en"
        remembered={{ question: 'Can I change my order?' }}
        onValues={() => undefined}
        onAgree={async () => undefined}
        onLeave={async () => {
          throw new Error('not in this test');
        }}
        onConsentRequired={async () => undefined}
        onBack={() => undefined}
      />,
    );
    expect(html).toContain('Leave a message');
    expect(html).toContain('Your email<span class="font-normal text-text-muted"> (required)');
    expect(html).toMatch(/<textarea[^>]*>Can I change my order\?<\/textarea>/);
    expect(html).toContain('We keep it.');
    expect(html).toContain('Send message');
    expect(html).toContain('Back to chat');
  });

  it('thanks with the reference, the brand’s words and where the link went', () => {
    const sent = (confirmationSent: boolean): OfflineMessageResponse => ({
      conversation: {} as CustomerConversation,
      reference: '#1042',
      email: 'a•••@example.com',
      confirmationSent,
    });
    const strip = (html: string) => html.replace(/<[^>]+>/g, '').replaceAll('&#x27;', '’');
    const fresh = strip(
      renderToString(
        <TicketThanks sent={sent(true)} thanks="We read every message." onBack={() => undefined} />,
      ),
    );
    expect(fresh).toContain('Message sent');
    expect(fresh).toContain('Your reference is #1042.');
    expect(fresh).toContain('We read every message.');
    expect(fresh).toContain(
      'We sent a link to a•••@example.com. Open it so we can send our answer there.',
    );
    expect(fresh).toContain('Back to start');
    const earlier = strip(
      renderToString(<TicketThanks sent={sent(false)} thanks="" onBack={() => undefined} />),
    );
    expect(earlier).toContain('We sent a link to a•••@example.com a short while ago.');
  });
});

describe('tickets (H19)', () => {
  it('says where a ticket stands in the customer’s words', () => {
    const t = i18next.t.bind(i18next);
    expect(ticketWords(t, { reference: '#1042', state: 'open' })).toEqual({
      label: 'Ticket #1042',
      state: 'Open',
    });
    expect(ticketWords(t, { reference: '#1042', state: 'pending' }).state).toBe(
      'Waiting for your reply',
    );
    expect(ticketWords(t, { reference: '#7', state: 'closed' }).state).toBe('Closed');
  });

  it('says it in the visitor’s language', async () => {
    await ensureLocale('ar');
    await i18next.changeLanguage('ar');
    const t = i18next.t.bind(i18next);
    expect(ticketWords(t, { reference: '#1042', state: 'pending' })).toEqual({
      label: 'التذكرة #1042',
      state: 'بانتظار ردك',
    });
  });

  it('lists a ticket with its reference and state instead of a bare “closed”', () => {
    const conversation = (id: string, ticket: CustomerConversation['ticket']) => ({
      id,
      status: 'resolved' as const,
      responder: 'none' as const,
      createdAt: '2026-10-09T10:00:00Z',
      updatedAt: '2026-10-09T10:00:00Z',
      unreadCount: 0,
      lastMessagePreview: 'Can I change my order?',
      latestSequence: 3,
      ticket,
      canReturnToAssistant: false,
    });
    const html = renderToString(
      <Conversations
        conversations={[
          conversation('conv_1', { reference: '#1042', state: 'closed' }),
          conversation('conv_2', null),
        ]}
        current={null}
        locale="en"
        onOpen={() => undefined}
        onBack={() => undefined}
      />,
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('Ticket <bdi');
    expect(html).toMatch(/#1042<\/bdi>/);
    expect(html).toContain('· Closed');
    expect(html.match(/data-testid="ticket"/g)).toHaveLength(1);
  });
});

describe('reopening (W15)', () => {
  it('offers “I still need help” with the rating, and after it', () => {
    const client = new HamnivoClient({
      apiBase: 'https://api.test',
      widgetId: 'wid_test',
      storage: new MemoryStorage(),
    });
    const render = () =>
      renderToString(
        <AnnouncerProvider>
          <Csat client={client} conversationId="conv_1" onReopen={async () => undefined} />
        </AnnouncerProvider>,
      );
    expect(render()).toContain('I still need help');
    client.storage.setItem('hamnivo:wid_test:rated:conv_1', '4');
    const thanked = render();
    expect(thanked).toContain('Thank you for your feedback.');
    expect(thanked).toContain('I still need help');
    // Without a way to reopen, the rating is asked as before.
    expect(
      renderToString(
        <AnnouncerProvider>
          <Csat client={client} conversationId="conv_2" />
        </AnnouncerProvider>,
      ),
    ).not.toContain('I still need help');
  });
});

describe('the direct chat link (W28)', () => {
  it('reads the widget from the page’s path, and nothing else', () => {
    expect(directWidgetId('/c/wid_abc123')).toBe('wid_abc123');
    expect(directWidgetId('/c/wid_abc123/')).toBe('wid_abc123');
    expect(directWidgetId('/c/wid%5Fabc')).toBe('wid_abc');
    for (const other of ['/', '/index.html', '/c/', '/c/a/b', '/x/wid_abc', '/c/%E0%A4%A']) {
      expect(directWidgetId(other), other).toBeNull();
    }
  });

  it('keeps the page out of search results, once', () => {
    const added: { name: string; content: string }[] = [];
    const doc = {
      querySelector: () => (added.length ? {} : null),
      createElement: () => ({ name: '', content: '' }),
      head: { append: (meta: { name: string; content: string }) => added.push(meta) },
    } as unknown as Document;
    noIndex(doc);
    noIndex(doc);
    expect(added).toEqual([{ name: 'robots', content: 'noindex' }]);
  });
});
