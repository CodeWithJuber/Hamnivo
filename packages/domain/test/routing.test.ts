import { describe, expect, it } from 'vitest';
import {
  baselineIntent,
  chooseTeam,
  type DecisionResult,
  decideRoute,
  type ExperimentRecord,
  OTHER_INTENT,
  type RoutingAnswers,
  type RoutingIntent,
  type RoutingTeam,
  rankStaffForLanguage,
  routingQuestion,
  summarizeExperiment,
  validateIntents,
} from '../src/index.js';

const intents: RoutingIntent[] = [
  {
    key: 'billing',
    description: 'Payments, refunds and invoices',
    keywords: ['refund', 'payment', 'invoice', 'paise', 'ادائیگی', 'رقم', 'भुगतान'],
  },
  {
    key: 'orders',
    description: 'Delivery and order status',
    keywords: ['delivery', 'order', 'parcel', 'ڈیلیوری', 'طلبي', 'ऑर्डर'],
  },
  { key: 'technical', description: 'Sign-in and errors', keywords: ['login', 'password', 'error'] },
];

const teams: RoutingTeam[] = [
  { id: 'billing-en', intents: ['billing'], languages: ['en'], accepting: true },
  {
    id: 'billing-ur',
    intents: ['billing'],
    languages: ['ur', 'roman-urdu'],
    accepting: true,
  },
  {
    id: 'orders',
    intents: ['orders'],
    languages: ['en'],
    translationLanguages: ['ar'],
    accepting: true,
  },
  {
    id: 'support',
    intents: [],
    languages: ['en', 'ar', 'hi', 'ur', 'hinglish', 'roman-urdu'],
    accepting: true,
    isDefault: true,
  },
];

describe('intents', () => {
  it('validates intent keys and descriptions', () => {
    expect(validateIntents(intents)).toBeUndefined();
    expect(validateIntents([])).toMatch(/at least one/);
    expect(validateIntents([{ key: 'Bad Key', description: 'x', keywords: [] }])).toMatch(
      /not valid/,
    );
    expect(validateIntents([{ key: OTHER_INTENT, description: 'x', keywords: [] }])).toMatch(
      /automatically/,
    );
    expect(
      validateIntents([
        { key: 'a', description: 'x', keywords: [] },
        { key: 'a', description: 'y', keywords: [] },
      ]),
    ).toMatch(/twice/);
  });

  it('asks the provider to choose among the brand intents plus other', () => {
    const question = routingQuestion(intents);
    expect(question.type).toBe('choice');
    expect(Object.keys(question.labels)).toEqual(['billing', 'orders', 'technical', 'other']);
  });
});

describe('baselineIntent', () => {
  it.each([
    ['My payment failed, I need a refund', 'billing'],
    ['Order pay ho gaya, delivery nahi mili', 'orders'],
    ['میری ڈیلیوری کہاں ہے؟', 'orders'],
    ['أين طلبي؟', 'orders'],
    ['मेरा भुगतान वापस करें', 'billing'],
    ['I forgot my password', 'technical'],
    ['hello there', OTHER_INTENT],
  ])('%s → %s', (text, intent) => {
    expect(baselineIntent(text, intents).intent).toBe(intent);
  });

  it('chooses other on a tie and says so', () => {
    const result = baselineIntent('refund for my delivery', intents);
    expect(result).toEqual({ intent: OTHER_INTENT, matches: { billing: 1, orders: 1 }, tie: true });
  });
});

describe('chooseTeam (U07)', () => {
  it('prefers a team that speaks the customer language', () => {
    expect(chooseTeam({ intent: 'billing', language: 'roman-urdu', teams })).toEqual({
      teamId: 'billing-ur',
      languageMatch: 'native',
      basis: 'intent',
    });
    expect(chooseTeam({ intent: 'billing', language: 'en', teams }).teamId).toBe('billing-en');
  });

  it('uses a reviewed translation path before accepting a language gap', () => {
    expect(chooseTeam({ intent: 'orders', language: 'ar', teams })).toEqual({
      teamId: 'orders',
      languageMatch: 'translation',
      basis: 'intent',
    });
    expect(chooseTeam({ intent: 'orders', language: 'hi', teams })).toEqual({
      teamId: 'orders',
      languageMatch: 'none',
      basis: 'intent',
    });
  });

  it('routes other and unhandled intents to a default team', () => {
    expect(chooseTeam({ intent: OTHER_INTENT, language: 'hi', teams })).toEqual({
      teamId: 'support',
      languageMatch: 'native',
      basis: 'default',
    });
    expect(chooseTeam({ intent: 'technical', language: null, teams })).toEqual({
      teamId: 'support',
      languageMatch: 'unknown',
      basis: 'default',
    });
  });

  it('treats equally fitting languages of an ambiguous message as native', () => {
    // "paise wapas kab milenge" fits Hinglish and Roman Urdu alike.
    expect(
      chooseTeam({ intent: 'billing', language: 'hinglish', alternatives: ['roman-urdu'], teams }),
    ).toEqual({ teamId: 'billing-ur', languageMatch: 'native', basis: 'intent' });
    expect(chooseTeam({ intent: 'billing', language: 'hinglish', teams })).toEqual({
      teamId: 'billing-en',
      languageMatch: 'none',
      basis: 'intent',
    });
  });

  it('only routes to teams that are accepting conversations', () => {
    const paused = teams.map((t) => (t.id === 'billing-ur' ? { ...t, accepting: false } : t));
    expect(chooseTeam({ intent: 'billing', language: 'ur', teams: paused })).toEqual({
      teamId: 'billing-en',
      languageMatch: 'none',
      basis: 'intent',
    });
    const closed = teams.map((t) => ({ ...t, accepting: false }));
    expect(chooseTeam({ intent: 'billing', language: 'ur', teams: closed })).toEqual({
      teamId: null,
      languageMatch: 'none',
      basis: 'none',
    });
  });
});

describe('rankStaffForLanguage (U07)', () => {
  it('orders available people who speak the language first, then by load', () => {
    const staff = [
      { id: 'away-urdu', languages: ['ur' as const], available: false },
      { id: 'busy-urdu', languages: ['ur' as const], available: true, load: 5 },
      { id: 'english', languages: ['en' as const], available: true, load: 0 },
      {
        id: 'free-urdu',
        languages: ['ur' as const, 'roman-urdu' as const],
        available: true,
        load: 1,
      },
    ];
    expect(rankStaffForLanguage(staff, 'ur').map((s) => s.id)).toEqual([
      'free-urdu',
      'busy-urdu',
      'english',
      'away-urdu',
    ]);
    expect(rankStaffForLanguage(staff, null).map((s) => s.id)).toEqual([
      'english',
      'free-urdu',
      'busy-urdu',
      'away-urdu',
    ]);
  });
});

const audit = {
  provider: 'jev',
  task: 'team-routing',
  rubricVersion: 'routing-v1',
  latencyMs: 90,
  language: 'en' as const,
};
const decided = (label: string): DecisionResult<RoutingAnswers> => ({
  ...audit,
  status: 'decided',
  modelVersion: 'jev-1.13.0',
  value: {
    intent: { type: 'choice', label, confidence: 0.9, probabilities: { [label]: 0.9 } },
  },
});
const offered = ['billing', 'orders', 'technical', OTHER_INTENT];

describe('decideRoute', () => {
  const baseline = baselineIntent('where is my order', intents);

  it('uses a decided provider answer with an offered intent', () => {
    const route = decideRoute({
      provider: decided('billing'),
      baseline,
      offered,
      language: 'en',
      teams,
      explicitRequest: false,
    });
    expect(route).toMatchObject({ intent: 'billing', source: 'provider', fallback: null });
    expect(route.team.teamId).toBe('billing-en');
  });

  it.each([
    [null, 'not_asked', null],
    [{ ...audit, status: 'abstained', reason: 'below threshold' } as const, 'abstained', null],
    [
      { ...audit, status: 'unavailable', retryable: true, reason: 'deadline' } as const,
      'unavailable',
      'deadline',
    ],
    [
      { ...audit, status: 'unavailable', retryable: true, reason: 'circuit_open' } as const,
      'unavailable',
      'circuit_open',
    ],
    [{ ...audit, status: 'invalid', reason: 'bad label' } as const, 'invalid', null],
  ])('falls back to the baseline when the provider result is %j', (provider, fallback, reason) => {
    const route = decideRoute({
      provider: provider as DecisionResult<RoutingAnswers> | null,
      baseline,
      offered,
      language: 'en',
      teams,
      explicitRequest: false,
    });
    expect(route).toMatchObject({
      intent: 'orders',
      source: 'baseline',
      fallback,
      unavailable: reason,
    });
    expect(route.team.teamId).toBe('orders');
  });

  it('never routes on a label that was not offered', () => {
    const route = decideRoute({
      provider: decided('refunds_vip'),
      baseline,
      offered,
      language: 'en',
      teams,
      explicitRequest: false,
    });
    expect(route).toMatchObject({ source: 'baseline', fallback: 'label_not_offered' });
  });

  it('only picks a destination for a customer who asked for a person', () => {
    const route = decideRoute({
      provider: decided(OTHER_INTENT),
      baseline,
      offered,
      language: 'hi',
      teams,
      explicitRequest: true,
    });
    expect(route.explicitRequest).toBe(true);
    expect(route.team).toEqual({ teamId: 'support', languageMatch: 'native', basis: 'default' });
  });
});

describe('summarizeExperiment (J08)', () => {
  const record = (overrides: Partial<ExperimentRecord>): ExperimentRecord => ({
    status: 'decided',
    language: 'en',
    providerIntent: 'billing',
    baselineIntent: 'billing',
    reviewedIntent: null,
    latencyMs: 100,
    inputTokens: 50,
    outputTokens: 2,
    ...overrides,
  });

  it('reports agreement on decided records only and failures separately', () => {
    const report = summarizeExperiment([
      record({}),
      record({ providerIntent: 'orders', latencyMs: 300 }),
      record({ status: 'unavailable', providerIntent: null, latencyMs: 1500, inputTokens: null }),
      record({ status: 'abstained', language: 'ur', providerIntent: null, latencyMs: 200 }),
    ]);
    expect(report.overall).toMatchObject({
      records: 4,
      decided: 2,
      abstained: 1,
      unavailable: 1,
      agreement: 0.5,
      reviewed: 0,
      providerAccuracy: null,
      baselineAccuracy: null,
      latencyP50Ms: 200,
      latencyP95Ms: 1500,
      inputTokens: 150,
      outputTokens: 8,
    });
    expect(report.byLanguage.ur).toMatchObject({ records: 1, abstained: 1, agreement: null });
  });

  it('measures accuracy only against reviewer labels', () => {
    const report = summarizeExperiment([
      record({ reviewedIntent: 'billing' }),
      record({ providerIntent: 'orders', reviewedIntent: 'orders' }),
      record({ status: 'unavailable', providerIntent: null, reviewedIntent: 'billing' }),
    ]);
    expect(report.overall.providerAccuracy).toBe(1);
    expect(report.overall.baselineAccuracy).toBe(0.6667);
  });
});
