/**
 * Channel senders in Studio: a blocked email, WhatsApp or Telegram sender on the Blocked page, and
 * the banner for channels that stopped working (A11), rendered to HTML from seeded data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceNotices } from '../src/components/WorkspaceNotices';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import { blockKeys, type VisitorBlock } from '../src/lib/blocks';
import type { WorkspaceNotices as Notices } from '../src/lib/types';
import { BlockedPage } from '../src/pages/visitors/BlockedPage';
import { anchors, renderStudio, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const NOW = Date.now();

const block = (patch: Partial<VisitorBlock> = {}): VisitorBlock => ({
  id: 'blk_1',
  brandId: 'brd_1',
  name: null,
  code: '7F3A',
  signedIn: false,
  channel: null,
  customerId: 'cus_1',
  visitorId: null,
  conversationId: null,
  reason: 'Spam',
  createdBy: { id: 'staff_1', name: 'Sara Staff' },
  createdAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: null,
  liftedAt: null,
  liftedBy: null,
  active: true,
  ...patch,
});

const blocked = (items: VisitorBlock[]) =>
  renderStudio({
    at: '/blocked',
    permissions: ['visitors.block'],
    screen: <BlockedPage status="active" brandId="" onChange={() => {}} />,
    seed: (client) => client.setQueryData([TENANT_ID, ...blockKeys.list('', 'active')], { items }),
  });

/** The text of each row of the blocks table. */
const rows = (html: string) =>
  [...html.matchAll(/<tr[^>]*data-testid="block-row"[^>]*>([\s\S]*?)<\/tr>/g)].map((match) =>
    textOf(match[1] ?? ''),
  );

describe('blocked senders on the Blocked page', () => {
  it('names a sender by their address and channel, or the channel alone on Telegram', async () => {
    const html = await blocked([
      block({ id: 'blk_1', channel: { kind: 'email', address: 'amina@customer.example' } }),
      block({ id: 'blk_2', channel: { kind: 'whatsapp', address: '+971501234567' } }),
      block({ id: 'blk_3', channel: { kind: 'telegram', address: null } }),
      block({ id: 'blk_4' }),
    ]);
    const [email, whatsapp, telegram, visitor] = rows(html);
    expect(email).toContain('amina@customer.example on Email');
    expect(whatsapp).toContain('+971501234567 on WhatsApp');
    expect(telegram).toContain('Telegram sender');
    expect(visitor).toContain('Visitor 7F3A');
    expect(visitor).not.toContain(' on ');
    // The address reads left to right, in Arabic too.
    expect(html).toContain('<bdi dir="ltr">+971501234567</bdi>');
    expect(html).toContain('aria-label="Unblock +971501234567 on WhatsApp"');
    expect(html).toContain('aria-label="Unblock Telegram sender"');
  });

  it('keeps a sender’s name as the main label, with their address under it', async () => {
    const html = await blocked([
      block({ name: 'Amina Khan', channel: { kind: 'email', address: 'amina@customer.example' } }),
    ]);
    expect(rows(html)[0]).toContain('Amina Khan amina@customer.example on Email');
    expect(html).toContain('aria-label="Unblock Amina Khan"');
  });
});

const notices = (unhealthyChannels: Notices['unhealthyChannels']) =>
  renderStudio({
    at: '/overview',
    permissions: ['integrations.manage'],
    screen: <WorkspaceNotices />,
    seed: (client) =>
      client.setQueryData<Notices>([TENANT_ID, ...accessKeys.notices], {
        supportAccess: [],
        pendingSupportRequests: 0,
        incidents: [],
        unhealthyChannels,
      }),
  });

const channel = (
  patch: Partial<Notices['unhealthyChannels'][number]> = {},
): Notices['unhealthyChannels'][number] => ({
  id: 'inbox_1' as never,
  brandId: 'brd_1' as never,
  brandName: 'Acme',
  kind: 'whatsapp',
  name: 'Sales WhatsApp',
  address: '+971501234567',
  problem: 'Invalid access token',
  since: '2026-10-09T14:05:00.000Z' as never,
  ...patch,
});

describe('channels that stopped working (A11)', () => {
  it('shows nothing while every channel works', async () => {
    expect(await notices([])).not.toContain('data-testid="notices"');
  });

  it('names one channel, what Chatwoot says, and links to its brand’s channels', async () => {
    const html = await notices([channel()]);
    const text = textOf(html);
    expect(text).toMatch(
      /The WhatsApp channel of Acme has not worked since .+\. New messages may not reach your team\./,
    );
    expect(text).toContain('Sales WhatsApp · +971501234567');
    expect(text).toContain('Chatwoot says: Invalid access token');
    expect(anchors(html)).toContainEqual(
      expect.objectContaining({ href: '/channels?brand=brd_1', text: 'Fix it' }),
    );
  });

  it('counts several and lists each, linking to the first one’s brand', async () => {
    const html = await notices([
      channel(),
      channel({
        id: 'inbox_2' as never,
        brandId: 'brd_2' as never,
        brandName: 'Noor',
        kind: 'email',
      }),
      channel({ id: 'inbox_3' as never, kind: 'telegram', address: null }),
    ]);
    const text = textOf(html);
    expect(text).toContain(
      'Channels that have stopped working: 3. New messages may not reach your team.',
    );
    expect(text).toContain('The Email channel of Noor, since');
    expect(text).toContain('The Telegram channel of Acme, since');
    expect(anchors(html).filter((link) => link.text === 'Fix it')).toEqual([
      expect.objectContaining({ href: '/channels?brand=brd_1' }),
    ]);
  });
});
