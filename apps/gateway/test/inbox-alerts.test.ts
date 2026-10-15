import { describe, expect, it } from 'vitest';
import {
  type AlertChat,
  type AlertMessage,
  deriveAlerts,
  messageKey,
  previewOf,
} from '../src/inbox/alerts.js';
import { effectiveStatus, SEEN_TTL_MS } from '../src/inbox/availability.service.js';

const ME = 'staff-me';
const OTHER = 'staff-other';
const T0 = new Date('2026-10-03T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const chat = (overrides: Partial<AlertChat> = {}): AlertChat => ({
  id: 'c1',
  authorityStatus: 'open',
  ownerMode: 'WAITING_HUMAN',
  ownerStaffId: null,
  ownerReason: 'customer_request',
  ownerChangedAt: at(-60),
  createdAt: at(-3600),
  customerName: 'Maya Khan',
  ...overrides,
});
const message = (seconds: number, overrides: Partial<AlertMessage> = {}): AlertMessage => ({
  conversationId: 'c1',
  messageId: `msg-${seconds}`,
  text: 'Where is my order?',
  at: at(seconds),
  ...overrides,
});
const derive = (
  chats: AlertChat[],
  messages: AlertMessage[] = [],
  since = T0,
  seen?: ReadonlySet<string>,
) => deriveAlerts({ me: ME, since, chats, messages, ...(seen ? { seen } : {}) }).alerts;

describe('alerts for the staff inbox', () => {
  it('tells everyone about a chat that has just started to wait for a person', () => {
    const alerts = derive([chat({ ownerChangedAt: at(5) })], [message(4)]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'chat_waiting',
      conversationId: 'c1',
      customerName: 'Maya Khan',
      preview: 'Where is my order?',
    });
  });

  it('treats a chat without an owner change as new from its creation time', () => {
    const alerts = derive([chat({ ownerChangedAt: null, createdAt: at(2) })]);
    expect(alerts.map((a) => a.kind)).toEqual(['chat_waiting']);
    expect(derive([chat({ ownerChangedAt: null, createdAt: at(-2) })])).toEqual([]);
  });

  it('says a customer wrote in a chat that is already waiting', () => {
    const alerts = derive([chat()], [message(3)]);
    expect(alerts).toMatchObject([{ kind: 'customer_message', preview: 'Where is my order?' }]);
  });

  it('alerts the owner of a chat when the customer writes, and nobody else', () => {
    const mine = chat({
      ownerMode: 'HUMAN_ACTIVE',
      ownerStaffId: ME,
      ownerReason: 'staff_takeover',
    });
    const theirs = chat({
      id: 'c2',
      ownerMode: 'HUMAN_ACTIVE',
      ownerStaffId: OTHER,
      ownerReason: 'staff_takeover',
    });
    const ai = chat({ id: 'c3', ownerMode: 'AI_ACTIVE', ownerReason: 'return_to_ai' });
    const alerts = derive(
      [mine, theirs, ai],
      [message(3), message(3, { conversationId: 'c2' }), message(3, { conversationId: 'c3' })],
    );
    expect(alerts.map((a) => [a.conversationId, a.kind])).toEqual([['c1', 'customer_message']]);
  });

  it('alerts a person when someone else assigns or transfers a chat to them, not when they take it', () => {
    const assigned = chat({
      ownerMode: 'HUMAN_ACTIVE',
      ownerStaffId: ME,
      ownerReason: 'staff_assign',
      ownerChangedAt: at(4),
    });
    expect(derive([assigned]).map((a) => a.kind)).toEqual(['assigned']);
    expect(
      derive([{ ...assigned, ownerReason: 'authority_assignment' }]).map((a) => a.kind),
    ).toEqual(['assigned']);
    expect(derive([{ ...assigned, ownerReason: 'staff_takeover' }])).toEqual([]);
    expect(derive([{ ...assigned, ownerStaffId: OTHER }])).toEqual([]);
  });

  it('sends one alert per chat: the most important, with the customer’s words', () => {
    const assigned = chat({
      ownerMode: 'HUMAN_ACTIVE',
      ownerStaffId: ME,
      ownerReason: 'staff_assign',
      ownerChangedAt: at(4),
    });
    const alerts = derive([assigned], [message(3), message(6, { text: 'Hello?' })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'assigned', preview: 'Hello?' });
  });

  it('shows the customer’s latest words on a chat that starts waiting, however old they are', () => {
    const alerts = derive(
      [chat({ ownerChangedAt: at(5) })],
      [message(-120, { text: 'Where is my order?' })],
    );
    expect(alerts).toMatchObject([{ kind: 'chat_waiting', preview: 'Where is my order?' }]);
  });

  it('keeps the newest message of a chat as the one that alerts', () => {
    const alerts = derive(
      [chat()],
      [message(3, { text: 'First' }), message(9, { text: 'Second', messageId: 'newest' })],
    );
    expect(alerts).toMatchObject([{ kind: 'customer_message', preview: 'Second' }]);
    expect(alerts[0]?.key).toBe('c1:message:newest');
  });

  it('ignores resolved and snoozed chats, and messages from before the look', () => {
    expect(derive([chat({ authorityStatus: 'resolved', ownerChangedAt: at(5) })])).toEqual([]);
    expect(derive([chat({ authorityStatus: 'snoozed' })], [message(3)])).toEqual([]);
    expect(derive([chat()], [message(-1)])).toEqual([]);
  });

  it('gives the same alert the same key, so a stream sends it once', () => {
    const first = derive([chat({ ownerChangedAt: at(5) })]);
    const again = derive([chat({ ownerChangedAt: at(5) })], [], at(-2));
    expect(first[0]?.key).toBe(again[0]?.key);
  });

  it('does not alert again for a message a stream already looked at, when looks overlap', () => {
    const waitingChat = chat({ ownerChangedAt: at(5) });
    const first = deriveAlerts({
      me: ME,
      since: T0,
      chats: [waitingChat],
      messages: [message(4)],
    });
    expect(first.alerts.map((a) => a.kind)).toEqual(['chat_waiting']);
    expect(first.looked).toEqual([messageKey(message(4))]);

    // The next look starts a few seconds before the last one, so it sees the same chat and message.
    const seen = new Set([...first.looked, ...first.alerts.map((a) => a.key)]);
    expect(derive([waitingChat], [message(4)], at(-3), seen)).toEqual([]);

    // A message that came in after that still alerts, even inside the overlap.
    const next = derive(
      [waitingChat],
      [message(4), message(7, { messageId: 'later' })],
      at(-3),
      seen,
    );
    expect(next).toMatchObject([{ kind: 'customer_message', key: 'c1:message:later' }]);
  });

  it('lists the newest message of every chat it looked at, alerted or not', () => {
    const decision = deriveAlerts({
      me: ME,
      since: T0,
      chats: [chat(), chat({ id: 'c2', authorityStatus: 'resolved' })],
      messages: [
        message(-9),
        message(-2, { messageId: 'newest' }),
        message(3, { conversationId: 'c2' }),
      ],
    });
    expect(decision.alerts).toEqual([]);
    expect(decision.looked).toEqual(['c1:message:newest']);
  });

  it('tells the owner and people who see a waiting chat that it went past its reply time, once', () => {
    const late = chat({ slaBreachedAt: at(7) });
    const alerts = derive([late], [message(3)]);
    expect(alerts).toMatchObject([
      { kind: 'sla_overdue', key: `c1:sla:${at(7).getTime()}`, preview: 'Where is my order?' },
    ]);
    // The owner hears it; a chat someone else has does not concern this person.
    const owned = chat({ ownerMode: 'HUMAN_ACTIVE', ownerStaffId: ME, slaBreachedAt: at(7) });
    expect(derive([owned]).map((a) => a.kind)).toEqual(['sla_overdue']);
    const theirs = chat({ ownerMode: 'HUMAN_ACTIVE', ownerStaffId: OTHER, slaBreachedAt: at(7) });
    expect(derive([theirs])).toEqual([]);
    // Once per deadline: not before the look, and not again once seen.
    expect(derive([chat({ slaBreachedAt: at(-5) })])).toEqual([]);
    const key = alerts[0]?.key ?? '';
    expect(derive([late], [], T0, new Set([key])).map((a) => a.kind)).toEqual([]);
  });

  it('tells only the person offered a chat about it, once per offer (HNV-10-03)', () => {
    const offered = chat({
      ownerChangedAt: at(2),
      ownershipEpoch: 4,
      teamOffers: true,
      offerId: 'o1',
      offerStaffId: ME,
      offeredAt: at(3),
    });
    expect(derive([offered], [message(1)])).toMatchObject([
      { kind: 'chat_offered', key: 'c1:offer:o1', preview: 'Where is my order?', at: at(3) },
    ]);
    expect(derive([offered], [], T0, new Set(['c1:offer:o1']))).toEqual([]);
    // The rest of the team is not called while the chat is offered to someone.
    expect(derive([{ ...offered, offerStaffId: OTHER }])).toEqual([]);
  });

  it('tells the team a chat is waiting once the offers ended without anyone accepting', () => {
    const ended = chat({
      ownerChangedAt: at(-30),
      ownershipEpoch: 4,
      teamOffers: true,
      offersEndedAt: at(6),
      offersEndedEpoch: 4,
    });
    expect(derive([ended])).toMatchObject([
      { kind: 'chat_waiting', key: `c1:waiting:${at(6).getTime()}`, at: at(6) },
    ]);
    // Offers that ended for an earlier hand-off do not count: this one is still being offered.
    expect(derive([{ ...ended, ownerChangedAt: at(5), offersEndedEpoch: 3 }])).toEqual([]);
    // A team that does not offer chats calls everyone at once, as before.
    expect(derive([chat({ ownerChangedAt: at(5), teamOffers: false })]).map((a) => a.kind)).toEqual(
      ['chat_waiting'],
    );
  });

  it('calls a customer without a name a visitor, and cuts a long message to one short line', () => {
    expect(derive([chat({ customerName: null, ownerChangedAt: at(1) })])[0]?.customerName).toBe(
      'Visitor',
    );
    expect(previewOf('  a\n\n b   c ')).toBe('a b c');
    expect(previewOf('x'.repeat(500))).toHaveLength(200);
    expect(previewOf('   ')).toBeNull();
    expect(previewOf(null)).toBeNull();
  });
});

describe('online, away and offline', () => {
  const now = 1_000_000;
  const heard = { at: now - 10_000, active: true };

  it('shows a person online while Studio is open and used', () => {
    expect(effectiveStatus('online', heard, now)).toBe('online');
  });

  it('shows them away when they chose it, or when Studio is open but unused', () => {
    expect(effectiveStatus('away', heard, now)).toBe('away');
    expect(effectiveStatus('online', { ...heard, active: false }, now)).toBe('away');
  });

  it('shows them offline when they chose it, or when Studio is not heard from', () => {
    expect(effectiveStatus('offline', heard, now)).toBe('offline');
    expect(effectiveStatus('online', null, now)).toBe('offline');
    expect(effectiveStatus('away', { at: now - SEEN_TTL_MS - 1, active: true }, now)).toBe(
      'offline',
    );
  });
});
