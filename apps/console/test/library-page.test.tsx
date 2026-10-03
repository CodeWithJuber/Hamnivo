import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { ApiError } from '../src/lib/api';
import { inboxKeys } from '../src/lib/inbox';
import { libraryKeys, type SavedReplyRecord, type TagRecord } from '../src/lib/library';
import { keys } from '../src/lib/queries';
import { InboxToolbar } from '../src/pages/inbox/InboxToolbar';
import { NoTagsHint } from '../src/pages/library/LibraryHints';
import { LibraryPage } from '../src/pages/library/LibraryPage';
import { ReplyForm } from '../src/pages/library/RepliesSection';
import { TagForm } from '../src/pages/library/TagsSection';
import { anchors, renderStudio, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const MANAGER = ['inbox.manage', 'conversations.read', 'brands.manage'];

const brand = (id: string, name: string) => ({
  id,
  workspaceId: 'wsp_1',
  name,
  widgetId: `wid_${id}`,
  allowedOrigins: ['https://noor.example'],
  businessHours: null,
  status: 'active',
  createdAt: '2026-10-01T09:00:00.000Z',
});

const reply = (n: number, shortCode: string, content: string): SavedReplyRecord => ({
  id: `srp_${n}` as never,
  shortCode,
  content,
});

const REPLIES: SavedReplyRecord[] = [
  reply(1, 'refund-policy', 'You can return it within 30 days.\nWrite to us first.'),
  reply(2, 'hours', 'We are open 9 to 5, Monday to Friday.'),
];
const TAGS: TagRecord[] = [
  { title: 'vip', description: 'Top customers', color: '#ff8800' },
  { title: 'refund', description: null, color: null },
];

/** Puts a query in the state it has after the gateway refused it, and keeps it there. */
function failed(client: QueryClient, key: readonly unknown[], error: Error) {
  // Without this a screen would ask again as it opens, and show "loading" instead of the refusal.
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retryOnMount: false },
  });
  client
    .getQueryCache()
    .build(client, { queryKey: [TENANT_ID, ...key] })
    .setState({
      status: 'error',
      error,
      fetchStatus: 'idle',
      errorUpdateCount: 1,
      errorUpdatedAt: Date.now(),
      fetchFailureCount: 1,
    });
}

interface Options {
  permissions?: readonly string[];
  brands?: ReturnType<typeof brand>[];
  requested?: string;
  replies?: Record<string, SavedReplyRecord[]>;
  tags?: Record<string, TagRecord[]>;
  seed?: (client: QueryClient) => void;
}

const show = ({
  permissions = MANAGER,
  brands = [brand('brd_1', 'Noor Books')],
  requested,
  replies = { brd_1: REPLIES },
  tags = { brd_1: TAGS },
  seed,
}: Options = {}) =>
  renderStudio({
    at: '/saved-replies',
    permissions,
    screen: (
      <AnnouncerProvider>
        <LibraryPage requested={requested} onBrand={() => undefined} />
      </AnnouncerProvider>
    ),
    seed: (client) => {
      client.setQueryData([TENANT_ID, ...keys.brands], { items: brands });
      for (const [brandId, items] of Object.entries(replies)) {
        client.setQueryData([TENANT_ID, ...libraryKeys.replies(brandId)], { items });
      }
      for (const [brandId, items] of Object.entries(tags)) {
        client.setQueryData([TENANT_ID, ...libraryKeys.tags(brandId)], { items });
      }
      seed?.(client);
    },
  });

const rows = (html: string, testId: string) =>
  [...html.matchAll(new RegExp(`<tr[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</tr>`, 'g'))].map(
    (match) => textOf(match[1] ?? ''),
  );

describe('saved replies and tags page', () => {
  it('names the page, says changes apply to the whole team and links back to the inbox', async () => {
    const html = await show();
    const text = textOf(html);
    expect(text).toContain('Saved replies and tags');
    expect(text).toContain('A change applies to everyone who answers customers for this brand.');
    expect(anchors(html).find((link) => link.href === '/inbox')?.text).toContain('Back to inbox');
    // Two lists, each a landmark named by its heading.
    expect(html).toContain('aria-labelledby="library-replies-title"');
    expect(html).toContain('aria-labelledby="library-tags-title"');
  });

  it('lists each saved reply with its short code and text, and what can be done to it', async () => {
    const html = await show();
    const list = rows(html, 'reply-row');
    expect(list).toHaveLength(2);
    expect(list[0]).toContain('refund-policy');
    expect(list[0]).toContain('You can return it within 30 days.');
    expect(list[1]).toContain('hours');
    expect(html).toContain('<caption');
    for (const label of [
      'Edit saved reply refund-policy',
      'Delete saved reply refund-policy',
      'Edit saved reply hours',
      'Delete saved reply hours',
    ]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
    expect(textOf(html)).toContain('Add a saved reply');
    expect(html).toContain('data-testid="add-reply"');
  });

  it('lists each tag with its description and colour, naming the tag beside the colour', async () => {
    const html = await show();
    const list = rows(html, 'tag-row');
    expect(list).toHaveLength(2);
    expect(list[0]).toContain('vip');
    expect(list[0]).toContain('Top customers');
    // A tag without a description shows a dash; one without a colour gets the default blue.
    expect(list[1]).toContain('refund');
    expect(list[1]).toContain('—');
    const row = [...html.matchAll(/<tr[^>]*data-testid="tag-row"[^>]*>([\s\S]*?)<\/tr>/g)];
    expect(row[0]?.[1]).toContain('background-color:#ff8800');
    expect(row[1]?.[1]).toContain('background-color:#1f93ff');
    for (const label of [
      'Edit tag vip',
      'Delete tag vip',
      'Edit tag refund',
      'Delete tag refund',
    ]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('data-testid="add-tag"');
  });

  it('offers a search only once there are enough saved replies to need one', async () => {
    expect(await show()).not.toContain('id="reply-search"');
    const many = Array.from({ length: 7 }, (_, n) => reply(n + 10, `code-${n}`, `Text ${n}`));
    const html = await show({ replies: { brd_1: many } });
    expect(html).toContain('id="reply-search"');
    expect(textOf(html)).toContain('Search saved replies');
    expect(rows(html, 'reply-row')).toHaveLength(7);
  });

  it('says what to do when there are no saved replies or tags yet', async () => {
    const html = await show({ replies: { brd_1: [] }, tags: { brd_1: [] } });
    const text = textOf(html);
    expect(text).toContain('No saved replies yet');
    expect(text).toContain('Add the answers your team writes again and again');
    expect(text).toContain('No tags yet');
    expect(text).toContain('Add tags such as vip or refund');
    // The way to add one is in the empty state, and there is no empty table.
    expect(html.match(/data-testid="add-reply"/g)).toHaveLength(1);
    expect(html.match(/data-testid="add-tag"/g)).toHaveLength(1);
    expect(html).not.toContain('data-testid="reply-table"');
    expect(html).not.toContain('data-testid="tag-table"');
  });

  it('says plainly when the brand has no chat account, instead of two errors', async () => {
    const notSetUp = new ApiError(422, 'VALIDATION_FAILED', {
      code: 'VALIDATION_FAILED',
      status: 422,
      title: 'x',
      reason: 'no_chat_account',
    } as never);
    const html = await show({
      replies: {},
      tags: {},
      seed: (client) => {
        failed(client, libraryKeys.replies('brd_1'), notSetUp);
        failed(client, libraryKeys.tags('brd_1'), notSetUp);
      },
    });
    const text = textOf(html);
    expect(text).toContain('Chat is not set up for Noor Books yet');
    expect(text).toContain('Connect the brand to chat first.');
    expect(anchors(html).find((link) => link.href === '/brands')?.text).toBe(
      'Open Brands and install',
    );
    expect(html).not.toContain('data-testid="add-reply"');
  });

  it('says there is nothing to show when there is no brand yet', async () => {
    const html = await show({ brands: [], replies: {}, tags: {} });
    expect(textOf(html)).toContain('There is no brand yet.');
    expect(html).not.toContain('data-testid="add-reply"');
  });

  it('is closed to someone who does not manage the inbox', async () => {
    const html = await show({ permissions: ['conversations.read', 'brands.manage'] });
    expect(textOf(html)).toContain('Saved replies and tags are not available to you');
    expect(textOf(html)).toContain('Your role does not include managing the inbox.');
    expect(html).not.toContain('data-testid="reply-row"');
    expect(html).not.toContain('data-testid="add-tag"');
  });

  it('shows the brand in the link, with a picker when there are several', async () => {
    const outlet = brand('brd_2', 'Noor Outlet');
    const html = await show({
      brands: [brand('brd_1', 'Noor Books'), outlet],
      requested: 'brd_2',
      replies: { brd_1: REPLIES, brd_2: [reply(5, 'outlet-hours', 'Outlet hours: 10 to 6.')] },
      tags: { brd_1: TAGS, brd_2: [{ title: 'clearance', description: null, color: '#16a34a' }] },
    });
    const select = html.match(/<select[^>]*id="library-brand"[^>]*>([\s\S]*?)<\/select>/);
    expect(select?.[1]).toMatch(/<option[^>]*value="brd_2"[^>]*selected/);
    expect(textOf(html)).toContain('Brand');
    // Only the chosen brand's lists are shown.
    expect(rows(html, 'reply-row')).toEqual([expect.stringContaining('outlet-hours')]);
    expect(rows(html, 'tag-row')).toEqual([expect.stringContaining('clearance')]);

    // One brand needs no picker.
    expect(await show()).not.toContain('id="library-brand"');
  });
});

describe('the form for a saved reply', () => {
  const form = (existing: SavedReplyRecord | null = null) =>
    renderStudio({
      at: '/saved-replies',
      permissions: MANAGER,
      screen: (
        <AnnouncerProvider>
          <ReplyForm brandId="brd_1" reply={existing} codes={['hours']} onDone={() => undefined} />
        </AnnouncerProvider>
      ),
    });

  it('asks for a short code and the text, and offers details the chat fills in', async () => {
    const html = await form();
    const text = textOf(html);
    expect(text).toContain('Short code');
    expect(text).toContain('Letters, numbers, - and _ only, no spaces.');
    expect(text).toContain('Up to 5,000 characters.');
    expect(text).toContain('Add saved reply');
    for (const [detail, token] of [
      ['Customer’s first name', '{{contact.first_name}}'],
      ['Customer’s full name', '{{contact.name}}'],
      ['Your name', '{{agent.name}}'],
      ['Brand name', '{{inbox.name}}'],
    ]) {
      expect(text, detail).toContain(detail as string);
      expect(html, token).toContain(`data-token="${(token as string).replace(/"/g, '&quot;')}"`);
    }
    expect(text).toContain('If it is not known, the person is asked to fill it in by hand.');
    // The text stops at the limit the gateway enforces.
    expect(html).toMatch(/<textarea[^>]*id="reply-text"[^>]*maxLength="5000"/i);
  });

  it('starts from the reply being edited, with Save off until something changes', async () => {
    const html = await form(REPLIES[0] as SavedReplyRecord);
    expect(html).toMatch(/<input[^>]*id="reply-code"[^>]*value="refund-policy"/);
    expect(html).toContain('You can return it within 30 days.');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled[^>]*>/);
    expect(textOf(html)).toContain('Save');
  });
});

describe('the form for a tag', () => {
  const form = (existing: TagRecord | null = null) =>
    renderStudio({
      at: '/saved-replies',
      permissions: MANAGER,
      screen: (
        <AnnouncerProvider>
          <TagForm brandId="brd_1" tag={existing} names={['refund']} onDone={() => undefined} />
        </AnnouncerProvider>
      ),
    });

  const radios = (html: string) =>
    [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => match[0]);

  it('asks for a name, a description and a colour, starting on blue', async () => {
    const html = await form();
    const text = textOf(html);
    expect(text).toContain('Name');
    expect(text).toContain('It is kept in lower case.');
    expect(text).toContain('Description');
    expect(text).toContain('Optional. Up to 200 characters.');
    expect(text).toContain('Colour');
    expect(text).toContain('Chosen colour: Blue');
    expect(text).toContain('Add tag');
    const all = radios(html);
    expect(all).toHaveLength(8);
    const checked = all.filter((radio) => /checked/.test(radio));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="#1f93ff"');
    // Every colour has its name for people who cannot tell colours apart.
    for (const name of ['Blue', 'Green', 'Teal', 'Orange', 'Red', 'Pink', 'Purple', 'Grey']) {
      expect(html, name).toContain(`<span class="sr-only">${name}</span>`);
    }
    // Nothing about renaming until a tag is being renamed.
    expect(html).not.toContain('data-testid="rename-note"');
  });

  it('starts from the tag being edited, with Save off until something changes', async () => {
    const html = await form({ title: 'vip', description: 'Top customers', color: '#16A34A' });
    expect(html).toMatch(/<input[^>]*id="tag-name"[^>]*value="vip"/);
    expect(html).toMatch(/<input[^>]*id="tag-description"[^>]*value="Top customers"/);
    expect(textOf(html)).toContain('Chosen colour: Green');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled[^>]*>/);
  });

  it('keeps a colour made elsewhere as one more choice, chosen, so an edit does not lose it', async () => {
    const html = await form({ title: 'legacy', description: null, color: '#123456' });
    const all = radios(html);
    expect(all).toHaveLength(9);
    expect(all.filter((radio) => /checked/.test(radio))[0]).toContain('value="#123456"');
    expect(textOf(html)).toContain('Chosen colour: Custom (#123456)');
  });
});

describe('where staff find the page', () => {
  const preferences = {
    alerts: {
      sounds: {
        muted: false,
        volume: 60,
        newChat: 'chime',
        customerMessage: 'pop',
        assigned: 'bell',
      },
      desktop: { enabled: true, showPreview: true },
    },
    availability: { choice: 'online', effective: 'online' },
  };
  const toolbar = (permissions: readonly string[]) =>
    renderStudio({
      at: '/inbox',
      permissions,
      screen: <AnnouncerProvider>{<InboxToolbar />}</AnnouncerProvider>,
      seed: (client) => client.setQueryData([TENANT_ID, ...inboxKeys.preferences], preferences),
    });

  it('puts a button for it above the list of chats, for people who manage the inbox only', async () => {
    const manager = await toolbar(['conversations.read', 'inbox.manage']);
    const link = anchors(manager).find((a) => a.href === '/saved-replies');
    expect(link?.text).toBe('Saved replies and tags');
    expect(manager).toContain('data-testid="saved-replies-link"');
    // The live visitors button is still there for everyone.
    expect(anchors(manager).some((a) => a.href === '/visitors')).toBe(true);

    const agent = await toolbar(['conversations.read', 'conversations.reply']);
    expect(agent).not.toContain('data-testid="saved-replies-link"');
    expect(anchors(agent).some((a) => a.href === '/visitors')).toBe(true);
  });

  const hint = (permissions: readonly string[], brandId?: string): Promise<string> =>
    renderStudio({
      at: '/inbox',
      permissions,
      screen: (<NoTagsHint brandId={brandId} />) as ReactNode,
    });

  it('tells staff with no tags to pick from who can add them, without sending them to Chatwoot', async () => {
    const asManager = await hint(['inbox.manage'], 'brd_1');
    expect(textOf(asManager)).toBe('No tags are set up for this brand yet. Add tags');
    expect(anchors(asManager)).toEqual([
      expect.objectContaining({ href: '/saved-replies?brand=brd_1', text: 'Add tags' }),
    ]);
    // Without a brand the link opens the page on its first brand.
    expect(anchors(await hint(['inbox.manage']))[0]?.href).toBe('/saved-replies');

    const asAgent = await hint(['conversations.read']);
    expect(textOf(asAgent)).toBe(
      'No tags are set up for this brand yet. Ask someone who manages the inbox to add them.',
    );
    expect(anchors(asAgent)).toEqual([]);
    expect(textOf(asManager) + textOf(asAgent)).not.toContain('Chatwoot');
  });
});
