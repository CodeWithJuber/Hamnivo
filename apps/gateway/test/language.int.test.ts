import { randomUUID } from 'node:crypto';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

type Tenant = Awaited<ReturnType<typeof connectedTenant>>;

let slice: Slice;
let tenant: Tenant;

// Replies of the mock model, one per reply language (see @hamnivo/adapters/models).
const REPLY_MARKERS = {
  en: 'Thank you for your message',
  ur: 'آپ کے پیغام کا شکریہ',
  hi: 'आपके संदेश के लिए धन्यवाद',
  'hi-Latn': 'Aapke message ke liye dhanyavaad',
  'ur-Latn': 'Aap ke paighaam ka shukriya',
} as const;

// Words that fit Hinglish and Roman Urdu equally.
const AMBIGUOUS = 'Order pay ho gaya, delivery nahi mili';

beforeAll(async () => {
  slice = await startSlice({ model: createMockModel() });
  tenant = await connectedTenant(slice, 'language');
  const detail = await tenant.owner.get(`/v1/admin/agents/${tenant.agentId}`);
  const config = detail.body.published?.config ?? detail.body.draft.config;
  const draft = await tenant.owner.put(`/v1/admin/agents/${tenant.agentId}/draft`, {
    config: { ...config, languages: ['en', 'ar', 'hi', 'ur'] },
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(200);
  const published = await tenant.owner.post(`/v1/admin/agents/${tenant.agentId}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
});

afterAll(async () => {
  await slice?.close();
});

async function visitor(locale?: 'en' | 'ar' | 'hi' | 'ur') {
  const v = new Visitor(slice.baseUrl, tenant.brand.widgetId, tenant.hostOrigin);
  const session = await v.call('POST', '/v1/widget/sessions', {
    widgetId: tenant.brand.widgetId,
    hostOrigin: tenant.hostOrigin,
    ...(locale ? { locale } : {}),
  });
  expect(session.status, JSON.stringify(session.body)).toBe(201);
  v.adopt(session.body);
  return v;
}

/** Sends a message (a new conversation, or into `conversationId`) and returns the AI's reply. */
async function say(v: Visitor, text: string, conversationId?: string) {
  let id = conversationId;
  if (id) {
    const sent = await v.call('POST', `/v1/widget/conversations/${id}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text }],
    });
    expect(sent.status).toBe(202);
  } else {
    const started = await v.call('POST', '/v1/widget/conversations', {
      firstMessage: text,
      clientMessageId: randomUUID(),
    });
    expect(started.status).toBe(201);
    id = started.body.id as string;
  }
  await slice.drain();
  const history = await v.call('GET', `/v1/widget/conversations/${id}/messages`);
  const replies = (history.body.items as Array<Record<string, any>>).filter(
    (m) => m.sender.kind === 'ai_agent',
  );
  // Newest first.
  const reply = replies[0];
  const runs = await tenant.owner.get(`/v1/admin/runs?conversationId=${id}`);
  const latest = (runs.body.items as Array<{ id: string; startedAt: string }>).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  )[0];
  const run = await tenant.owner.get(`/v1/admin/runs/${latest?.id}`);
  const generate = (run.body.steps as Array<Record<string, any>>).find(
    (s) => s.name === 'generate' && s.status === 'ok',
  );
  return {
    conversationId: id,
    text: reply?.parts.find((p: { type: string }) => p.type === 'text')?.text as string | undefined,
    step: generate?.detail as Record<string, unknown> | undefined,
  };
}

describe('reply language (U01)', () => {
  it('starts from the widget locale, then follows the customer’s explicit choice', async () => {
    const v = await visitor('ar');
    const initial = await v.call('GET', '/v1/widget/language');
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      uiLocale: 'ar',
      replyLanguage: 'ar',
      source: 'locale',
      confirm: null,
      style: { verbosity: null, tone: null },
    });

    const chosen = await v.call('PUT', '/v1/widget/language', { replyLanguage: 'ur' });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ uiLocale: 'ar', replyLanguage: 'ur', source: 'explicit' });

    // An explicit choice wins over the words of the message.
    const reply = await say(v, 'Where is my parcel? I ordered it last week.');
    expect(reply.text).toContain(REPLY_MARKERS.ur);
    expect(reply.step).toMatchObject({ language: 'ur', languageSource: 'explicit' });

    // The interface locale is separate from the reply language.
    const locale = await v.call('PUT', '/v1/widget/language', { uiLocale: 'hi' });
    expect(locale.body).toMatchObject({ uiLocale: 'hi', replyLanguage: 'ur', source: 'explicit' });

    // Preferences keep choices and detected candidates only, never the words.
    const [row] = await withTenant(
      slice.app,
      { tenantId: fromPublicId('tenant', tenant.tenantId) },
      (tx) =>
        tx
          .select()
          .from(schema.languagePreferences)
          .where(
            eq(schema.languagePreferences.principalId, fromPublicId('customer', v.principalId)),
          ),
    );
    expect(row).toMatchObject({ explicitLanguage: 'ur', uiLocale: 'hi', lastDetected: ['en'] });
    expect(JSON.stringify(row)).not.toContain('parcel');
  });

  it('answers in the language of each message when nothing was chosen', async () => {
    const v = await visitor('en');
    const hindi = await say(v, 'मेरा ऑर्डर कहाँ है? मैंने पिछले हफ्ते मंगवाया था।');
    expect(hindi.text).toContain(REPLY_MARKERS.hi);
    expect(hindi.step).toMatchObject({ language: 'hi', languageSource: 'detected' });
    const english = await say(
      v,
      'Thanks. Can you also tell me about returns?',
      hindi.conversationId,
    );
    expect(english.text).toContain(REPLY_MARKERS.en);
    expect(english.step).toMatchObject({ language: 'en', languageSource: 'detected' });
  });

  it('never treats Hinglish or Roman Urdu as English, and asks once when they are ambiguous', async () => {
    const v = await visitor('ur');
    const first = await say(v, AMBIGUOUS);
    // The Urdu locale suggests Roman Urdu; the reply is not in English.
    expect(first.text).toContain(REPLY_MARKERS['ur-Latn']);
    expect(first.text).not.toContain(REPLY_MARKERS.en);
    expect(first.step).toMatchObject({ language: 'ur-Latn', languageSource: 'suggested' });

    const asked = await v.call('GET', '/v1/widget/language');
    expect(asked.body).toMatchObject({
      replyLanguage: 'ur-Latn',
      confirm: { suggested: 'ur-Latn', alternatives: ['hi-Latn'] },
    });

    // The customer answers: Hinglish. The question is not asked again.
    const answered = await v.call('PUT', '/v1/widget/language', { replyLanguage: 'hi-Latn' });
    expect(answered.body).toMatchObject({
      replyLanguage: 'hi-Latn',
      source: 'explicit',
      confirm: null,
    });
    const second = await say(v, AMBIGUOUS, first.conversationId);
    expect(second.text).toContain(REPLY_MARKERS['hi-Latn']);
    expect(second.step).toMatchObject({ language: 'hi-Latn', languageSource: 'explicit' });
    expect((await v.call('GET', '/v1/widget/language')).body.confirm).toBeNull();
  });

  it('stops asking once the customer closes the question without choosing', async () => {
    const v = await visitor('hi');
    const first = await say(v, AMBIGUOUS);
    expect(first.step).toMatchObject({ language: 'hi-Latn' });
    expect((await v.call('GET', '/v1/widget/language')).body.confirm).toEqual({
      suggested: 'hi-Latn',
      alternatives: ['ur-Latn'],
    });
    const dismissed = await v.call('PUT', '/v1/widget/language', { dismissPrompt: true });
    expect(dismissed.body).toMatchObject({ replyLanguage: 'hi-Latn', confirm: null });
    const again = await say(v, AMBIGUOUS, first.conversationId);
    // The language in use is kept, without asking.
    expect(again.step).toMatchObject({ language: 'hi-Latn', languageSource: 'previous' });
    expect((await v.call('GET', '/v1/widget/language')).body.confirm).toBeNull();
  });

  it('refuses unknown languages and requests without a widget session', async () => {
    const v = await visitor();
    const unknown = await v.call('PUT', '/v1/widget/language', { replyLanguage: 'fr' });
    expect(unknown.status).toBe(422);
    const anonymous = new Visitor(slice.baseUrl, tenant.brand.widgetId, tenant.hostOrigin);
    expect((await anonymous.call('GET', '/v1/widget/language')).status).toBe(401);
    expect(
      (await anonymous.call('PUT', '/v1/widget/language', { replyLanguage: 'ur' })).status,
    ).toBe(401);
  });
});
