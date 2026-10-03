import { randomUUID } from 'node:crypto';
import { DEFAULT_DECISION_THRESHOLDS } from '@hamnivo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * Team routing through the gateway with the real Jev service (J01, J02): opt-in, never part of
 * the default runs (`pnpm --filter @hamnivo/gateway test:live`). Skips itself without
 * TYPESAFE_API_KEY in the environment; the key is read from there only and never printed. About
 * seven calls, far below a cent.
 */
const key = process.env.TYPESAFE_API_KEY;

describe.skipIf(!key)('team routing with live Jev', () => {
  let slice: Slice;
  let alpha: Awaited<ReturnType<typeof connectedTenant>>;
  const teams: Record<string, string> = {};
  const path = () => `/v1/admin/brands/${alpha.brand.id}/decisions/team-routing`;
  /** Jev's latency per decision, reported at the end (numbers only). */
  const latencies: number[] = [];

  beforeAll(async () => {
    slice = await startSlice({ env: { TYPESAFE_API_KEY: key as string } });
    alpha = await connectedTenant(slice, 'live-routing');
    const team = async (name: string, routing: Record<string, unknown>) => {
      const created = await alpha.owner.post('/v1/admin/teams', {
        name,
        workspaceId: alpha.workspaceId,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const set = await alpha.owner.put(
        `/v1/admin/brands/${alpha.brand.id}/routing/teams/${created.body.id}`,
        routing,
      );
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      return created.body.id as string;
    };
    const everyLanguage = ['en', 'ar', 'hi', 'ur', 'hinglish', 'roman-urdu'];
    teams.Billing = await team('Billing', { intents: ['billing'], languages: everyLanguage });
    teams.Shipping = await team('Shipping', { intents: ['shipping'], languages: everyLanguage });
    teams.Support = await team('Support', { isDefault: true, languages: everyLanguage });

    // Before a rubric exists, Studio already knows this server can call Jev.
    const before = await alpha.owner.get(path());
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.jev).toMatchObject({ configured: true, recommendedModel: 'jev-1.13.0' });

    // Keywords that never match these messages: whatever routes them is Jev's answer.
    const draft = await alpha.owner.put(`${path()}/draft`, {
      definition: {
        intents: [
          {
            key: 'billing',
            description: 'Payments, charges, invoices and refunds',
            keywords: ['zzz-billing'],
          },
          {
            key: 'shipping',
            description: 'Delivery, parcels, tracking and delivery delays',
            keywords: ['zzz-shipping'],
          },
        ],
        thresholds: Object.fromEntries(
          Object.entries(DEFAULT_DECISION_THRESHOLDS.routing).map(([slice, minConfidence]) => [
            slice,
            { minConfidence },
          ]),
        ),
      },
      provider: 'jev',
      modelVersion: DEFAULT_DECISION_THRESHOLDS.model,
      deadlineMs: 1500,
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const published = await alpha.owner.post(`${path()}/publish`, {});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });

  afterAll(async () => {
    await slice?.close();
  });

  it.each([
    ['en', 'I was charged twice for one order, please refund the extra payment', 'billing'],
    ['ar', 'متى ستصل شحنتي؟ لم يتحرك التتبع منذ ثلاثة أيام', 'shipping'],
    ['hi', 'मेरे कार्ड से दो बार पैसे कट गए, एक वापस कर दीजिए', 'billing'],
    ['ur', 'میرا پارسل ابھی تک نہیں پہنچا، کب آئے گا؟', 'shipping'],
    ['roman-urdu', 'mera parcel abhi tak nahi aaya, tracking bhi update nahi ho rahi', 'shipping'],
  ])(
    'Studio’s test panel (%s): Jev decides within the deadline',
    async (_slice, message, intent) => {
      const tested = await alpha.owner.post(`${path()}/test`, { rubric: 'published', message });
      expect(tested.status, JSON.stringify(tested.body)).toBe(200);
      const record = tested.body.record as Record<string, any>;
      expect(record).toMatchObject({
        provider: 'jev',
        modelVersion: 'jev-1.13.0',
        status: 'decided',
        providerIntent: intent,
        finalIntent: intent,
        finalSource: 'provider',
        team: { id: intent === 'billing' ? teams.Billing : teams.Shipping },
        applied: false,
      });
      expect(record.confidence).toBeGreaterThanOrEqual(0.5);
      expect(record.latencyMs).toBeLessThan(1500);
      latencies.push(record.latencyMs);
      expect(record.inputTokens).toBeGreaterThan(0);
    },
  );

  it('records Jev next to the fixed rule for a real conversation in shadow mode', async () => {
    const visitor = new Visitor(slice.baseUrl, alpha.brand.widgetId, alpha.hostOrigin);
    await visitor.open();
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: 'Where is my parcel? It was due on Monday. My email is sam@example.com',
      clientMessageId: randomUUID(),
    });
    expect(started.status).toBe(201);
    await slice.drain();
    const listed = await alpha.owner.get(`${path()}/records?conversationId=${started.body.id}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const [record] = listed.body.items as Array<Record<string, any>>;
    expect(record).toMatchObject({
      trigger: 'new_conversation',
      mode: 'shadow',
      provider: 'jev',
      modelVersion: 'jev-1.13.0',
      status: 'decided',
      providerIntent: 'shipping',
      baselineIntent: 'other',
      finalSource: 'provider',
      applied: false,
    });
    expect(record?.latencyMs).toBeLessThan(1500);
    latencies.push(record?.latencyMs);
    const sorted = [...latencies].sort((a, b) => a - b);
    process.stdout.write(
      `live routing: ${sorted.length} Jev decisions, latency ms ${sorted.join(', ')}\n`,
    );
  });
});
