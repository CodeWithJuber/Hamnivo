import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import type { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import { CustomerMemoryCard } from '../src/components/memory/CustomerMemoryCard';
import { initI18n } from '../src/i18n';
import { aiPowerKeys } from '../src/lib/ai-power';
import { formatDateTime } from '../src/lib/format';
import { keys } from '../src/lib/queries';
import type { MemoryCustomerDetail, MemoryItem } from '../src/lib/types';
import { renderStudio, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const CONVERSATION = 'conv_1';
const CUSTOMER = 'cus_1';

function item(overrides: Partial<MemoryItem> & { id: string; key: string; value: string }) {
  return {
    customerId: CUSTOMER,
    brandId: 'brd_1',
    kind: 'preference',
    status: 'active',
    reviewStatus: 'auto',
    scope: 'person',
    purpose: 'Reply in the customer’s language',
    sensitivity: 'normal',
    evidenceStatus: 'unknown',
    source: {
      type: 'customer_statement',
      messageIds: ['msg_1'],
      conversationId: CONVERSATION,
      observedAt: '2026-10-01T09:00:00.000Z',
    },
    writtenBy: { type: 'ai', id: null, name: null },
    reason: 'extracted_from_message',
    note: null,
    version: 1,
    supersedes: null,
    supersededBy: null,
    conflictsWith: null,
    validFrom: '2026-10-01T09:00:00.000Z',
    validUntil: null,
    expiresAt: null,
    recordedAt: '2026-10-01T09:00:00.000Z',
    supersededAt: null,
    lastConfirmedAt: null,
    reviewedAt: null,
    policyVersion: 'memory-policy/1',
    ...overrides,
  } as MemoryItem;
}

const language = item({ id: 'mem_1', key: 'preferred_language', value: 'Urdu' });
const name = item({
  id: 'mem_2',
  key: 'preferred_name',
  value: 'Sana',
  source: {
    type: 'staff_entry',
    messageIds: [],
    conversationId: null,
    observedAt: '2026-09-20T09:00:00.000Z',
  },
});
const pending = item({
  id: 'mem_3',
  key: 'size_preference',
  value: 'Medium',
  status: 'pending',
  reviewStatus: 'pending',
  conflictsWith: 'mem_9',
});

function detail(overrides: Partial<MemoryCustomerDetail> = {}): MemoryCustomerDetail {
  return {
    customer: {
      id: CUSTOMER,
      brandId: 'brd_1',
      displayName: 'Sana',
      email: null,
      verified: true,
      since: '2026-09-01T09:00:00.000Z',
    },
    offered: true,
    consent: {
      state: 'granted',
      decidedAt: '2026-09-02T09:00:00.000Z',
      noticeVersion: 'memory-notice/1',
    },
    consentHistory: [],
    items: [language, name, pending],
    history: [],
    deletions: [],
    ...overrides,
  } as MemoryCustomerDetail;
}

const seeded =
  (customerId: string | null, memory?: MemoryCustomerDetail) => (client: QueryClient) => {
    client.setQueryData([TENANT_ID, ...aiPowerKeys.conversationMemory(CONVERSATION)], {
      customerId,
    });
    if (memory) client.setQueryData([TENANT_ID, ...keys.memoryCustomer(CUSTOMER)], memory);
  };

const card = (permissions: readonly string[], seed: (client: QueryClient) => void) =>
  renderStudio({
    at: '/inbox',
    permissions,
    screen: (
      <AnnouncerProvider>
        <CustomerMemoryCard conversationId={CONVERSATION} />
      </AnnouncerProvider>
    ),
    seed,
  });

const READER = ['memory.read'];
const MANAGER = ['memory.read', 'memory.manage', 'memory.delete'];

describe('what the AI remembers, beside the conversation', () => {
  it('lists each memory with what it says and where it came from', async () => {
    const html = await card(READER, seeded(CUSTOMER, detail()));
    const text = textOf(html);
    expect(text).toContain('What the AI remembers');
    expect(text).toContain('Memory on');
    expect(text).toContain('Agreed on');
    expect(text).toContain('Preferred language');
    expect(text).toContain('Urdu');
    expect(text).toContain('Preferred name');
    expect(text).toContain('Sana');
    // The source is named, with the day, and says when it came from this very conversation. Times
    // are shown in the viewer's own time zone, so the expected text is formatted the same way.
    const observed = formatDateTime('2026-10-01T09:00:00.000Z');
    const entered = formatDateTime('2026-09-20T09:00:00.000Z');
    expect(text).toContain(`Customer message · ${observed} · this conversation`);
    expect(text).toContain(`Entered by staff · ${entered}`);
    expect(text).not.toContain(`Entered by staff · ${entered} · this conversation`);
    expect(html).toContain('data-testid="memory-card-items"');
  });

  it('links to the customer’s whole memory', async () => {
    const html = await card(READER, seeded(CUSTOMER, detail()));
    const link = html.match(/<a\b[^>]*href="\/memory\/cus_1"[^>]*>([^<]*)<\/a>/);
    expect(link?.[1]).toBe('Open memory');
  });

  it('offers corrections and deletions only to people who may make them', async () => {
    const manager = await card(MANAGER, seeded(CUSTOMER, detail()));
    for (const label of ['Preferred language', 'Preferred name']) {
      expect(manager).toContain(`aria-label="Correct ${label}"`);
      expect(manager).toContain(`aria-label="Delete ${label}"`);
    }
    const reader = await card(READER, seeded(CUSTOMER, detail()));
    expect(reader).not.toContain('Correct Preferred language');
    expect(reader).not.toContain('Delete Preferred language');
    const deleter = await card(['memory.read', 'memory.delete'], seeded(CUSTOMER, detail()));
    expect(deleter).toContain('aria-label="Delete Preferred language"');
    expect(deleter).not.toContain('Correct Preferred language');
  });

  it('keeps a value waiting for review out of use, and sends the reviewer to the memory page', async () => {
    const html = await card(MANAGER, seeded(CUSTOMER, detail()));
    expect(textOf(html)).toContain('Needs review');
    expect(textOf(html)).toContain('Not used until someone confirms it.');
    const review = html.match(/<a\b[^>]*aria-label="Review Size"[^>]*>/)?.[0] ?? '';
    expect(review).toContain('href="/memory/cus_1?memory=mem_3"');
    // A value under review is not corrected here, only reviewed.
    expect(html).not.toContain('aria-label="Correct Size"');
    const reader = await card(READER, seeded(CUSTOMER, detail()));
    expect(reader).not.toContain('aria-label="Review Size"');
  });

  it('says so when the customer has not agreed, or the brand’s AI does not use memory', async () => {
    const declined = textOf(
      await card(
        READER,
        seeded(
          CUSTOMER,
          detail({
            consent: {
              state: 'declined',
              decidedAt: '2026-09-02T09:00:00.000Z',
              noticeVersion: null,
            },
            items: [],
          }),
        ),
      ),
    );
    expect(declined).toContain('Declined');
    expect(declined).toContain('Declined on');
    expect(declined).toContain('Nothing is remembered about this customer yet.');
    const off = textOf(await card(READER, seeded(CUSTOMER, detail({ offered: false }))));
    expect(off).toContain('does not use memory');
    const undecided = textOf(
      await card(
        READER,
        seeded(
          CUSTOMER,
          detail({
            consent: { state: 'undecided', decidedAt: null, noticeVersion: null },
            items: [],
          }),
        ),
      ),
    );
    expect(undecided).toContain('Not asked yet');
    expect(undecided).toContain('The customer hasn’t chosen yet.');
  });

  it('has no customer to show for a visitor nobody knows', async () => {
    const html = await card(READER, seeded(null));
    expect(textOf(html)).toContain('this visitor is not a known customer yet');
    expect(html).not.toContain('Open memory');
  });

  it('is not there for a person who may not read memory', async () => {
    const html = await card(['conversations.read'], seeded(CUSTOMER, detail()));
    expect(html).not.toContain('customer-memory-card');
    expect(textOf(html)).not.toContain('What the AI remembers');
  });

  it('shows what the customer said as text, in its own direction', async () => {
    const hostile = item({
      id: 'mem_7',
      key: 'delivery_note',
      value: '<img src=x onerror=alert(1)> ضع الطرد عند الباب',
    });
    const html = await card(READER, seeded(CUSTOMER, detail({ items: [hostile] })));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toMatch(/<bdi dir="auto"[^>]*>&lt;img/);
  });
});
