// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
import type { AiDraft, AiDraftList } from '../src/lib/ai-drafts';
import type { InboxDetail } from '../src/lib/inbox';
import { ConversationPane } from '../src/pages/inbox/ConversationPane';
import { type Answer, type Call, fakeGateway, mountStudio, SELF_ID, settle } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const agent = presetPermissions('agent');
const NOW = new Date().toISOString();
const DRAFTS = '/v1/inbox/conversations/conv_1/ai-drafts';
const APPROVE = `${DRAFTS}/aidr_1/approve`;
/** The reviewer's saved drafts and outgoing messages (the reply box's failed sends). */
const OUTGOING = '/v1/inbox/conversations/conv_1/drafts';

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
    [`GET ${OUTGOING}`]: { json: { drafts: [], outgoing: [] } },
    ...routes,
  });
  const next = () => {
    at += 1;
  };
  const mount = () =>
    mountStudio({ at: '/inbox/conv_1', permissions: agent, screen: <ConversationPane /> });
  return { gateway, next, mount };
}

/**
 * Approving the pending draft answers `failure` after the decision was recorded. The reviewer's
 * outgoing messages then hold its reply as `reply.state` says (null: not there, it went), under the
 * approve's clientRequestId, as the gateway keeps it.
 */
function failingApprove(
  failure: () => Answer,
  state: 'sending' | 'failed' | null,
  routes: Record<string, Answer | ((call: Call) => Answer)> = {},
) {
  const reply: { id?: string; state: 'sending' | 'failed' | null } = { state };
  const view = pane(
    detail(),
    [
      { pending: draft(), latest: null },
      // As the gateway answers: the decision is kept, whatever became of the send.
      { pending: null, latest: draft({ state: 'approved', decidedAt: NOW, decidedBy: me }) },
    ],
    {
      [`POST ${APPROVE}`]: (call) => {
        view.next();
        reply.id = String(call.body?.clientRequestId);
        return failure();
      },
      [`GET ${OUTGOING}`]: () => ({
        json: {
          drafts: [],
          outgoing:
            reply.id && reply.state
              ? [
                  {
                    clientMessageId: reply.id,
                    lane: 'public',
                    text: 'You can change it before dispatch [1].',
                    state: reply.state,
                    errorCode: reply.state === 'failed' ? 'AUTHORITY_UNAVAILABLE' : null,
                    updatedAt: NOW,
                  },
                ]
              : [],
        },
      }),
      ...routes,
    },
  );
  return { ...view, reply };
}

/** What the element with this test id said while listening, even for a moment. */
function listen(testId: string) {
  const said: string[] = [];
  const watch = new MutationObserver(() => {
    const line = document.querySelector(`[data-testid="${testId}"]`);
    if (line) said.push(line.textContent ?? '');
  });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { said, stop: () => watch.disconnect() };
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
    // Only the name keeps its own direction; the sentence follows the page (right to left in Urdu).
    expect(ended.textContent).toContain('\u2068Omar Agent\u2069 sent this draft.');
    expect(ended.querySelector('bdi')).toBeNull();
    expect(screen.queryByTestId('ai-draft')).toBeNull();
  });

  it('says "not sent" while the approved reply waits in the failed sends', async () => {
    const { gateway, reply, mount } = failingApprove(
      () => ({ problem: { status: 503, code: 'AUTHORITY_UNAVAILABLE' } }),
      'failed',
    );
    await mount();
    const card = await screen.findByTestId('ai-draft');
    // The conversation answers slowly after the send, so the draft comes back decided before the
    // send's own answer is complete.
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(String(input), 'http://gateway.test');
      if (pathname === '/v1/inbox/conversations/conv_1' && gateway.writes().length > 0) {
        await settle();
      }
      return answer(input, init);
    });
    // "Sent" is never said, not even for a moment while the send is still being answered.
    const ended = listen('ai-draft-ended');
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Approve and send' }));
    const unsent = await screen.findByTestId('ai-draft-unsent');
    ended.stop();
    expect(gateway.to('POST', APPROVE)).toHaveLength(1);
    // The failed send is the approve's reply: the same id.
    expect(gateway.to('POST', APPROVE)[0]?.body?.clientRequestId).toBe(reply.id);
    expect(within(screen.getByTestId('composer')).getAllByTestId('failed-send')).toHaveLength(1);
    expect(within(unsent).getByTestId('action-error').getAttribute('role')).toBe('alert');
    const line = within(unsent).getByTestId('ai-draft-not-sent');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent).toBe(
      'Not sent. Your reply is kept with your failed sends: try it again from the reply box.',
    );
    expect(ended.said).toEqual([]);
    expect(screen.queryByTestId('ai-draft-ended')).toBeNull();
    expect(document.body.textContent).not.toContain('sent this draft');
    await userEvent.setup().click(within(unsent).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('ai-draft-unsent')).toBeNull();
  });

  it.each([
    [
      'the connection dropped',
      (): Answer => {
        throw new TypeError('Failed to fetch');
      },
    ],
    ['a proxy answered 502', (): Answer => ({ status: 502 })],
  ])('says the draft was sent when only the answer was lost (%s)', async (_, failure) => {
    // The reply went: nothing waits in the reviewer's outgoing messages.
    const { gateway, mount } = failingApprove(failure, null);
    await mount();
    const card = await screen.findByTestId('ai-draft');
    const notSent = listen('ai-draft-not-sent');
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Approve and send' }));
    const ended = await screen.findByTestId('ai-draft-ended');
    notSent.stop();
    expect(gateway.to('POST', APPROVE)).toHaveLength(1);
    expect(ended.textContent).toContain('⁨Omar Agent⁩ sent this draft.');
    expect(notSent.said).toEqual([]);
    expect(screen.queryByTestId('ai-draft-unsent')).toBeNull();
    expect(document.body.textContent).not.toContain('Not sent. Your reply');
  });

  it('stops saying "not sent" once the reply is sent again from the reply box', async () => {
    const MESSAGES = '/v1/conversations/conv_1/messages';
    const { gateway, reply, mount } = failingApprove(
      () => ({ problem: { status: 503, code: 'AUTHORITY_UNAVAILABLE' } }),
      'failed',
      {
        [`POST ${MESSAGES}`]: () => {
          reply.state = null;
          return { json: { messageId: 'msg_1', status: 'accepted' } };
        },
      },
    );
    await mount();
    const card = await screen.findByTestId('ai-draft');
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Approve and send' }));
    expect(await screen.findByTestId('ai-draft-not-sent')).toBeTruthy();
    const failed = within(screen.getByTestId('composer')).getByTestId('failed-send');
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    const ended = await screen.findByTestId('ai-draft-ended');
    // The retry is the approve's own reply (its id), so it is never sent twice.
    expect(gateway.to('POST', MESSAGES)[0]?.body).toMatchObject({
      clientMessageId: reply.id,
      text: 'You can change it before dispatch [1].',
      visibility: 'public',
    });
    expect(ended.textContent).toContain('⁨Omar Agent⁩ sent this draft.');
    expect(screen.queryByTestId('ai-draft-not-sent')).toBeNull();
    expect(screen.queryByTestId('ai-draft-unsent')).toBeNull();
  });

  it('keeps the draft under way while its reply is still being sent', async () => {
    const { gateway, reply, mount } = failingApprove(() => ({ status: 504 }), 'sending');
    const { client } = await mount();
    const card = await screen.findByTestId('ai-draft');
    const notSent = listen('ai-draft-not-sent');
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Approve and send' }));
    // The send's change refreshed the outgoing messages; then its error came back.
    await waitFor(() => expect(gateway.to('GET', OUTGOING)).toHaveLength(2));
    await settle();
    expect(screen.getByTestId('ai-draft')).toBe(card);
    const approve = within(card).getByRole('button', { name: 'Approve and send' });
    expect(approve.getAttribute('aria-busy')).toBe('true');
    expect(within(card).queryByTestId('action-error')).toBeNull();
    expect(screen.queryByTestId('ai-draft-ended')).toBeNull();
    // It went.
    reply.state = null;
    await client.invalidateQueries();
    const ended = await screen.findByTestId('ai-draft-ended');
    notSent.stop();
    expect(ended.textContent).toContain('⁨Omar Agent⁩ sent this draft.');
    expect(notSent.said).toEqual([]);
  });

  it('claims neither way while the failed sends cannot be read', async () => {
    const { mount } = failingApprove(() => ({ status: 502 }), 'failed', {
      [`GET ${OUTGOING}`]: { problem: { status: 503, code: 'AUTHORITY_UNAVAILABLE' } },
    });
    await mount();
    const card = await screen.findByTestId('ai-draft');
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Approve and send' }));
    const unsent = await screen.findByTestId('ai-draft-unsent');
    expect(within(unsent).getByTestId('action-error')).toBeTruthy();
    expect(screen.queryByTestId('ai-draft-not-sent')).toBeNull();
    expect(screen.queryByTestId('ai-draft-ended')).toBeNull();
    await userEvent.setup().click(within(unsent).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('ai-draft-unsent')).toBeNull();
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
    // The summary links to a radio that exists, and moves there.
    const summary = within(dialog).getByRole('link', { name: 'Choose a reason.' });
    const target = document.getElementById(summary.getAttribute('href')?.slice(1) ?? '');
    expect(target?.getAttribute('role')).toBe('radio');
    await user.click(summary);
    expect(document.activeElement).toBe(target);
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
      '\u2068Omar Agent\u2069 rejected this draft: The tone is wrong.',
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

  it('can still be rejected once WhatsApp’s reply window has closed, but not sent', async () => {
    const { mount } = pane(
      detail({
        channel: 'whatsapp',
        replyWindowClosesAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      [{ pending: draft(), latest: null }],
    );
    await mount();
    const card = await screen.findByTestId('ai-draft');
    for (const name of ['Approve and send', 'Edit']) {
      expect(within(card).getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true');
    }
    const reject = within(card).getByRole('button', { name: 'Reject' });
    expect(reject.getAttribute('aria-disabled')).toBeNull();
    await userEvent.setup().click(reject);
    expect(await screen.findByTestId('reject-draft-dialog')).toBeTruthy();
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
