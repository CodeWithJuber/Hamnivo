// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { AiDraft, AiDraftList } from '../src/lib/ai-drafts';
import type { InboxDetail } from '../src/lib/inbox';
import { ConversationPane } from '../src/pages/inbox/ConversationPane';
import { type Answer, type Call, fakeGateway, mountStudio, SELF_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const agent = presetPermissions('agent');
const NOW = new Date().toISOString();
const DRAFTS = '/v1/inbox/conversations/conv_1/ai-drafts';

const detail = (patch: Partial<InboxDetail> = {}): InboxDetail => ({
  id: 'conv_1',
  brand: { id: 'brd_1', name: 'Noor Books' },
  inboxId: 'inb_1',
  channel: 'chat',
  status: 'open',
  customerStatus: 'open',
  ownerMode: 'WAITING_HUMAN',
  ownershipEpoch: 3,
  owner: { kind: 'none' } as InboxDetail['owner'],
  ownerReason: 'assist_mode',
  ownerChangedAt: NOW,
  team: null,
  customer: { displayName: 'Aisha Khan', identity: 'anonymous', language: 'en' },
  lastMessage: { preview: 'Can I change my address?', at: NOW, from: 'customer' },
  labels: [],
  snoozedUntil: null,
  ticket: null,
  priority: null,
  waitingSince: NOW,
  sla: null,
  aiDraftReady: true,
  offer: null,
  replyWindowClosesAt: null,
  unreadCount: 0,
  lastActivityAt: NOW,
  createdAt: NOW,
  permissions: {
    reply: true,
    note: true,
    takeover: true,
    assign: false,
    status: true,
    tag: true,
    review: false,
    bulk: false,
  },
  presence: [],
  aiAvailable: true,
  customerTyping: false,
  ...patch,
});

const draft = (patch: Partial<AiDraft> = {}): AiDraft => ({
  id: 'aidr_1',
  runId: 'run_1',
  state: 'pending',
  supersededReason: null,
  text: 'You can change it before dispatch [1].',
  sources: [
    {
      type: 'source',
      sourceId: 'doc_1',
      title: 'Delivery changes',
      url: 'https://kb.example/delivery',
      version: 'v1',
      excerpt: null,
      freshness: 'current',
    },
  ],
  language: 'en',
  agentName: 'Noor Assistant',
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  rejectReason: null,
  ...patch,
});

const me = { staffMemberId: SELF_ID, displayName: 'Omar Agent' };

/** The conversation open on its own, its drafts answering from `lists` in turn. */
function pane(
  conversation: InboxDetail,
  lists: AiDraftList[],
  routes: Record<string, Answer | ((call: Call) => Answer)> = {},
) {
  let at = 0;
  const gateway = fakeGateway({
    'GET /v1/inbox/conversations/conv_1': { json: conversation },
    [`GET ${DRAFTS}`]: () => ({ json: lists[Math.min(at, lists.length - 1)] }),
    ...routes,
  });
  const next = () => {
    at += 1;
  };
  const mount = () =>
    mountStudio({ at: '/inbox/conv_1', permissions: agent, screen: <ConversationPane /> });
  return { gateway, next, mount };
}

describe('an AI draft awaiting review (HNV-09-05)', () => {
  it('shows the draft with its public sources, and approving sends it as written', async () => {
    const { gateway, next, mount } = pane(
      detail(),
      [
        { pending: draft(), latest: null },
        { pending: null, latest: draft({ state: 'approved', decidedAt: NOW, decidedBy: me }) },
      ],
      {
        [`POST ${DRAFTS}/aidr_1/approve`]: () => {
          next();
          return {
            json: {
              draft: draft({ state: 'approved', decidedAt: NOW, decidedBy: me }),
              message: { messageId: 'msg_1', status: 'accepted' },
            },
          };
        },
      },
    );
    await mount();
    const card = await screen.findByTestId('ai-draft');
    expect(within(card).getByRole('heading', { name: 'AI draft for review' })).toBeTruthy();
    expect(card.textContent).toContain('Written by Noor Assistant (AI) from public sources.');
    expect(within(card).getByTestId('ai-draft-text').textContent).toBe(
      'You can change it before dispatch [1].',
    );
    const link = within(card).getByRole('link', { name: 'Delivery changes' });
    expect(link.getAttribute('href')).toBe('https://kb.example/delivery');

    await userEvent.setup().click(within(card).getByRole('button', { name: 'Approve and send' }));
    await waitFor(() => expect(gateway.to('POST', `${DRAFTS}/aidr_1/approve`)).toHaveLength(1));
    const body = gateway.to('POST', `${DRAFTS}/aidr_1/approve`)[0]?.body ?? {};
    expect(body).toEqual({ clientRequestId: expect.any(String), expectedEpoch: 3 });
    const ended = await screen.findByTestId('ai-draft-ended');
    expect(ended.getAttribute('role')).toBe('status');
    expect(ended.textContent).toContain('Omar Agent sent this draft.');
    expect(screen.queryByTestId('ai-draft')).toBeNull();
  });

  it('sends an edited draft, and will not send an empty one', async () => {
    const { gateway, mount } = pane(detail(), [{ pending: draft(), latest: null }], {
      [`POST ${DRAFTS}/aidr_1/approve`]: {
        json: {
          draft: draft({ state: 'edited', decidedAt: NOW, decidedBy: me }),
          message: { messageId: 'msg_1', status: 'accepted' },
        },
      },
    });
    await mount();
    const card = await screen.findByTestId('ai-draft');
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const box = within(card).getByLabelText('Edit the draft before sending');
    await waitFor(() => expect(document.activeElement).toBe(box));
    await user.clear(box);
    await user.click(within(card).getByRole('button', { name: 'Send edited' }));
    expect(card.textContent).toContain('Write the reply before sending it, or cancel editing.');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(gateway.to('POST', `${DRAFTS}/aidr_1/approve`)).toHaveLength(0);
    await user.type(box, 'Yes, until it ships today.');
    await user.click(within(card).getByRole('button', { name: 'Send edited' }));
    await waitFor(() =>
      expect(gateway.to('POST', `${DRAFTS}/aidr_1/approve`)[0]?.body).toEqual({
        clientRequestId: expect.any(String),
        expectedEpoch: 3,
        text: 'Yes, until it ships today.',
      }),
    );
  });

  it('asks why before rejecting, and sends nothing', async () => {
    const rejected = draft({
      state: 'rejected',
      decidedAt: NOW,
      decidedBy: me,
      rejectReason: 'wrong_tone',
    });
    const { gateway, next, mount } = pane(
      detail(),
      [
        { pending: draft(), latest: null },
        { pending: null, latest: rejected },
      ],
      {
        [`POST ${DRAFTS}/aidr_1/reject`]: () => {
          next();
          return { json: { draft: rejected } };
        },
      },
    );
    await mount();
    const card = await screen.findByTestId('ai-draft');
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByTestId('reject-draft-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject draft' }));
    expect(dialog.textContent).toContain('Choose a reason.');
    expect(gateway.to('POST', `${DRAFTS}/aidr_1/reject`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('radio', { name: 'The tone is wrong' }));
    await user.type(within(dialog).getByLabelText(/Note/), 'Too formal for us.');
    await user.click(within(dialog).getByRole('button', { name: 'Reject draft' }));
    await waitFor(() =>
      expect(gateway.to('POST', `${DRAFTS}/aidr_1/reject`)[0]?.body).toEqual({
        clientRequestId: expect.any(String),
        reason: 'wrong_tone',
        note: 'Too formal for us.',
      }),
    );
    expect((await screen.findByTestId('ai-draft-ended')).textContent).toContain(
      'Omar Agent rejected this draft: The tone is wrong.',
    );
    expect(gateway.to('POST', `${DRAFTS}/aidr_1/approve`)).toHaveLength(0);
  });

  it('says why it cannot be sent while a colleague handles the conversation', async () => {
    const { gateway, mount } = pane(
      detail({
        ownerMode: 'HUMAN_ACTIVE',
        owner: { kind: 'staff', staffMemberId: 'staff_amina', displayName: 'Amina' },
      }),
      [{ pending: draft(), latest: null }],
    );
    await mount();
    const card = await screen.findByTestId('ai-draft');
    const approve = within(card).getByRole('button', { name: 'Approve and send' });
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    expect(card.textContent).toContain('Amina is handling this conversation.');
    await userEvent.setup().click(approve);
    expect(gateway.to('POST', `${DRAFTS}/aidr_1/approve`)).toHaveLength(0);
  });

  it('says who decided first when a colleague got there before you', async () => {
    const { mount } = pane(detail(), [{ pending: draft(), latest: null }], {
      [`POST ${DRAFTS}/aidr_1/approve`]: {
        problem: {
          status: 409,
          code: 'AI_DRAFT_CLOSED',
          aiDraft: { state: 'approved', decidedBy: 'Rayan Lead' },
        },
      },
    });
    await mount();
    const card = await screen.findByTestId('ai-draft');
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Approve and send' }));
    const refused = await within(card).findByTestId('ai-draft-refused');
    expect(refused.getAttribute('role')).toBe('alert');
    expect(refused.textContent).toBe('Rayan Lead already decided on this draft.');
  });

  it('says once that the draft was replaced when the customer wrote again', async () => {
    const { next, mount } = pane(detail(), [
      { pending: draft(), latest: null },
      {
        pending: null,
        latest: draft({ state: 'superseded', supersededReason: 'customer_wrote', decidedAt: NOW }),
      },
    ]);
    const { client } = await mount();
    await screen.findByTestId('ai-draft');
    next();
    await client.invalidateQueries();
    const ended = await screen.findByTestId('ai-draft-ended');
    expect(ended.textContent).toContain('The draft was replaced: the customer wrote again.');
    await userEvent.setup().click(within(ended).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('ai-draft-ended')).toBeNull();
  });

  it('shows nothing for a conversation whose last draft ended before it was opened', async () => {
    const { gateway, mount } = pane(detail({ aiDraftReady: false }), [
      { pending: null, latest: draft({ state: 'approved', decidedAt: NOW, decidedBy: me }) },
    ]);
    await mount();
    await screen.findByTestId('conversation-title');
    expect(screen.queryByTestId('ai-draft')).toBeNull();
    expect(screen.queryByTestId('ai-draft-ended')).toBeNull();
    // With no draft ready, nothing is asked for.
    expect(gateway.to('GET', DRAFTS)).toHaveLength(0);
  });
});
