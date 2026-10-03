import { describe, expect, it } from 'vitest';
import {
  type AnswerCheckPair,
  answerCheckCorrection,
  answerCheckRequest,
  answerCheckThresholdKey,
  answerCheckVerdict,
  answeredSlice,
  answersRecord,
  type CitedClaim,
  citedClaims,
  DEFAULT_CHECK_THRESHOLDS,
  ESCALATION_QUESTIONS,
  escalationVerdict,
  type GatedAnswers,
  gateCheck,
  INBOUND_GUARD_QUESTIONS,
  inboundGuardVerdict,
  languageDecision,
  OUTBOUND_GUARD_QUESTIONS,
  outboundClaims,
  outboundGuardCorrection,
  PASSAGE_QUESTIONS,
  passageVerdict,
  SAFE_REPLIES,
  SAFE_REPLIES_STAFF,
  splitSentences,
  unbackedClaims,
} from '../src/checks.js';
import type { ChoiceAnswer, DecisionAnswers, DecisionResult } from '../src/decisions.js';
import { detectLanguage, REPLY_LANGUAGES, resolveReplyLanguage } from '../src/language.js';

describe('sentences of a reply', () => {
  it('splits at the end of a sentence in every script, keeping citations with their sentence', () => {
    expect(
      splitSentences(
        'Returns take 30 days [1]. Refunds go to the card.[2] واپسی ۳۰ دن میں ہوتی ہے۔ ' +
          'रिफ़ंड कार्ड में आता है। هل تحتاج إلى شيء آخر؟',
      ),
    ).toEqual([
      'Returns take 30 days [1].',
      'Refunds go to the card.[2]',
      'واپسی ۳۰ دن میں ہوتی ہے۔',
      'रिफ़ंड कार्ड में आता है।',
      'هل تحتاج إلى شيء آخر؟',
    ]);
  });

  it('does not end a sentence inside a number, and keeps a line of citations with the line before', () => {
    expect(splitSentences('It weighs 1.5 kg [1]\n[2]\nShipping is free!')).toEqual([
      'It weighs 1.5 kg [1] [2]',
      'Shipping is free!',
    ]);
  });
});

describe('claims a reply cites', () => {
  it('lists each citing sentence with the passages it points at, without the markers', () => {
    const claims = citedClaims(
      'Hello! Returns take 30 days [1][3]. We ship in 2 days [2, 9]. Anything else?',
      3,
    );
    expect(claims).toEqual([
      { sentence: 1, text: 'Returns take 30 days.', passages: [0, 2] },
      // [9] matches no passage the model saw, so it is left out, as it is on publication.
      { sentence: 2, text: 'We ship in 2 days.', passages: [1] },
    ]);
  });

  it('checks nothing when nothing is cited', () => {
    expect(citedClaims('I do not have that information. Shall I find a person?', 2)).toEqual([]);
    expect(citedClaims('Returns take 30 days [4].', 3)).toEqual([]);
  });
});

describe('the answer-check request', () => {
  const claims: CitedClaim[] = [
    { sentence: 0, text: 'Returns take 30 days.', passages: [0, 1] },
    { sentence: 1, text: 'Refunds go to the card.', passages: [1] },
  ];

  it('sends each claim and each passage once, with one question per pair', () => {
    const request = answerCheckRequest(claims, ['Return policy: 30 days.', 'Refunds: card.']);
    expect(request.state).toEqual({
      claim_1: 'Returns take 30 days.',
      passage_1: 'Return policy: 30 days.',
      passage_2: 'Refunds: card.',
      claim_2: 'Refunds go to the card.',
    });
    expect(Object.keys(request.questions)).toEqual(['c1_p1', 'c1_p2', 'c2_p2']);
    expect(request.questions.c2_p2).toEqual({
      type: 'choice',
      instructions: 'How does passage_2 relate to claim_2?',
      labels: {
        supports: 'passage_2 states claim_2 or directly implies that it is true',
        contradicts: 'passage_2 states the opposite of claim_2 or implies that it is false',
        says_nothing: 'passage_2 does not address what claim_2 asserts, either way',
      },
    });
    expect(request.pairs).toEqual([
      { question: 'c1_p1', claim: 0, passage: 0 },
      { question: 'c1_p2', claim: 0, passage: 1 },
      { question: 'c2_p2', claim: 1, passage: 1 },
    ]);
    expect(request.unchecked).toBe(0);
  });

  it('caps the pairs of one call and counts the rest as unchecked', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      sentence: i,
      text: `Claim ${i}.`,
      passages: [0],
    }));
    const request = answerCheckRequest(many, ['p']);
    expect(request.pairs).toHaveLength(12);
    expect(request.unchecked).toBe(2);
    expect(answerCheckThresholdKey('c3_p1')).toBe('relation');
  });
});

const choice = (label: string, confidence: number): ChoiceAnswer => ({
  type: 'choice',
  label,
  confidence,
  probabilities: { [label]: confidence },
});

function decided(value: DecisionAnswers): DecisionResult<DecisionAnswers> {
  return {
    status: 'decided',
    provider: 'jev',
    task: 'answer-check',
    rubricVersion: 'answer-check-v1',
    language: 'en',
    latencyMs: 120,
    modelVersion: 'jev-1.13.0',
    value,
  };
}

const expected = { provider: 'jev', modelVersion: 'jev-1.13.0', rubricVersion: 'answer-check-v1' };
const thresholds = { relation: { type: 'choice' as const, minConfidence: 0.8 } };

describe('thresholds one question at a time', () => {
  it('keeps answers at or above their threshold and sets the others aside, one by one', () => {
    const gated = gateCheck(
      decided({ c1_p1: choice('supports', 0.95), c2_p1: choice('contradicts', 0.6) }),
      expected,
      thresholds,
      answerCheckThresholdKey,
    );
    expect(gated.status).toBe('decided');
    expect(gated.kept.c1_p1).toMatchObject({ label: 'supports' });
    expect(gated.kept.c2_p1).toBeNull();
    expect(gated.shortfalls.c2_p1).toMatch(/below 0.8/);
    expect(answersRecord(gated)).toEqual({
      c1_p1: { type: 'choice', label: 'supports', confidence: 0.95, kept: true },
      c2_p1: { type: 'choice', label: 'contradicts', confidence: 0.6, kept: false },
    });
  });

  it('abstains as a whole for a language without thresholds or another model', () => {
    const result = decided({ c1_p1: choice('supports', 0.99) });
    expect(gateCheck(result, expected, undefined)).toMatchObject({
      status: 'abstained',
      reason: 'not evaluated for this language (en)',
      kept: {},
    });
    expect(
      gateCheck(result, { ...expected, modelVersion: 'jev-1.14.0' }, thresholds),
    ).toMatchObject({ status: 'abstained', reason: expect.stringMatching(/jev-1.14.0/) });
  });

  it('passes a provider failure through, never as an answer', () => {
    const gated = gateCheck(
      {
        status: 'unavailable',
        provider: 'jev',
        task: 'answer-check',
        rubricVersion: 'answer-check-v1',
        latencyMs: 1500,
        retryable: true,
        reason: 'deadline',
      },
      expected,
      thresholds,
    );
    expect(gated).toMatchObject({ status: 'unavailable', reason: 'deadline', kept: {} });
  });
});

describe('what the answer check decides', () => {
  const claims: CitedClaim[] = [
    { sentence: 0, text: 'Returns take 30 days.', passages: [0] },
    { sentence: 2, text: 'Refunds go to the card.', passages: [0, 1] },
  ];
  const pairs: AnswerCheckPair[] = [
    { question: 'c1_p1', claim: 0, passage: 0 },
    { question: 'c2_p1', claim: 1, passage: 0 },
    { question: 'c2_p2', claim: 1, passage: 1 },
  ];
  const gated = (kept: Record<string, ChoiceAnswer | null>): GatedAnswers => ({
    status: 'decided',
    reason: null,
    kept,
    shortfalls: {},
    observed: {},
  });

  it('passes when every cited sentence is supported by a passage it cites', () => {
    expect(
      answerCheckVerdict(
        claims,
        pairs,
        gated({
          c1_p1: choice('supports', 0.9),
          c2_p1: choice('says_nothing', 0.9),
          c2_p2: choice('supports', 0.9),
        }),
      ),
    ).toEqual({
      verdict: 'pass',
      claims: [
        { sentence: 0, verdict: 'supported' },
        { sentence: 2, verdict: 'supported' },
      ],
    });
  });

  it('fails a sentence a passage contradicts, or that no passage it cites addresses', () => {
    expect(
      answerCheckVerdict(
        claims,
        pairs,
        gated({
          c1_p1: choice('supports', 0.9),
          c2_p1: choice('supports', 0.9),
          c2_p2: choice('contradicts', 0.9),
        }),
      ).claims[1],
    ).toEqual({ sentence: 2, verdict: 'unsupported' });
    expect(
      answerCheckVerdict(
        claims,
        pairs,
        gated({
          c1_p1: choice('says_nothing', 0.9),
          c2_p1: choice('supports', 0.9),
          c2_p2: null,
        }),
      ),
    ).toEqual({
      verdict: 'fail',
      claims: [
        { sentence: 0, verdict: 'unsupported' },
        { sentence: 2, verdict: 'supported' },
      ],
    });
  });

  it('is unsure, not passed, when an answer fell below its threshold', () => {
    expect(
      answerCheckVerdict(
        claims,
        pairs,
        gated({ c1_p1: null, c2_p1: choice('supports', 0.9), c2_p2: null }),
      ),
    ).toEqual({
      verdict: 'unsure',
      claims: [
        { sentence: 0, verdict: 'unsure' },
        { sentence: 2, verdict: 'supported' },
      ],
    });
  });

  it('tells the model which sentences to leave out', () => {
    expect(answerCheckCorrection(['Returns take 90 days.'])).toContain('- "Returns take 90 days."');
  });
});

describe('escalation advice (J04)', () => {
  const noul = (probability: number, verdict?: boolean) => ({
    type: 'noul' as const,
    probability,
    ...(verdict === undefined ? {} : { verdict }),
  });
  const gatedWith = (kept: Record<string, ReturnType<typeof noul> | null>): GatedAnswers => ({
    status: 'decided',
    reason: null,
    kept,
    shortfalls: {},
    observed: {},
  });

  it('asks each condition on its own, with criteria that say the same thing', () => {
    expect(Object.keys(ESCALATION_QUESTIONS)).toEqual([
      'wants_person',
      'frustrated',
      'unresolved',
      'complaint',
      'legal_threat',
      'safety',
    ]);
    for (const question of Object.values(ESCALATION_QUESTIONS)) {
      expect(question.type).toBe('noul');
      expect(question.outcomes.true).toBeTruthy();
      expect(question.outcomes.false).toBeTruthy();
    }
  });

  it('hands over for a request, a safety risk, a legal threat or a complaint on its own', () => {
    expect(escalationVerdict(gatedWith({ legal_threat: noul(0.95, true) }))).toEqual({
      escalate: true,
      reasons: ['legal_threat'],
    });
    expect(
      escalationVerdict(gatedWith({ safety: noul(0.9, true), complaint: noul(0.9, true) })),
    ).toEqual({ escalate: true, reasons: ['safety', 'complaint'] });
  });

  it('needs frustration and an unsolved problem together; frustration alone does not escalate', () => {
    expect(escalationVerdict(gatedWith({ frustrated: noul(0.95, true) }))).toEqual({
      escalate: false,
      reasons: [],
    });
    expect(
      escalationVerdict(gatedWith({ frustrated: noul(0.95, true), unresolved: noul(0.9, true) })),
    ).toEqual({ escalate: true, reasons: ['unresolved_and_frustrated'] });
  });

  it('counts only answers that met their threshold', () => {
    expect(escalationVerdict(gatedWith({ legal_threat: null, safety: noul(0.2, false) }))).toEqual({
      escalate: false,
      reasons: [],
    });
  });

  it('starts from the evaluated thresholds for a request for a person, and nothing else', () => {
    expect(DEFAULT_CHECK_THRESHOLDS.escalation?.en).toEqual({
      wants_person: { type: 'noul', trueAtLeast: 0.8, falseAtMost: 0.5 },
    });
    expect(DEFAULT_CHECK_THRESHOLDS.escalation?.['roman-urdu']?.wants_person).toMatchObject({
      trueAtLeast: 0.9,
    });
  });
});

describe('passage relevance (J03)', () => {
  const verdictOf = (verdicts: Record<string, boolean | null>) =>
    passageVerdict({
      status: 'decided',
      reason: null,
      kept: Object.fromEntries(
        Object.entries(verdicts).map(([key, verdict]) => [
          key,
          verdict === null ? null : { type: 'noul', probability: verdict ? 0.9 : 0.1, verdict },
        ]),
      ),
      shortfalls: {},
      observed: {},
    });

  it('asks about one passage and the question, never whether to keep it', () => {
    expect(Object.keys(PASSAGE_QUESTIONS)).toEqual([
      'is_relevant',
      'contains_answer_evidence',
      'contains_prompt_injection',
    ]);
  });

  it('drops instructions aimed at the assistant first, whatever else the passage says', () => {
    expect(
      verdictOf({
        contains_prompt_injection: true,
        is_relevant: true,
        contains_answer_evidence: true,
      }),
    ).toEqual({ keep: false, reason: 'injection' });
  });

  it('drops a passage about something else, or one that answers nothing; keeps one that answers', () => {
    expect(verdictOf({ is_relevant: false, contains_answer_evidence: true })).toEqual({
      keep: false,
      reason: 'off_topic',
    });
    expect(verdictOf({ is_relevant: true, contains_answer_evidence: false })).toEqual({
      keep: false,
      reason: 'no_evidence',
    });
    expect(verdictOf({ is_relevant: true, contains_answer_evidence: true })).toEqual({
      keep: true,
      reason: null,
    });
  });

  it('keeps a passage when the answers are not sure enough to drop it', () => {
    expect(
      verdictOf({
        contains_prompt_injection: null,
        is_relevant: null,
        contains_answer_evidence: null,
      }),
    ).toEqual({ keep: true, reason: null });
  });
});

describe('the reply language with Jev (U01)', () => {
  const answered = (label: string, kept: boolean): GatedAnswers => {
    const answer = { type: 'choice' as const, label, confidence: 0.9, probabilities: {} };
    return {
      status: 'decided',
      reason: null,
      kept: { language: kept ? answer : null },
      shortfalls: {},
      observed: { language: answer },
    };
  };
  const latin = ['hi-Latn', 'ur-Latn'] as const;

  it('takes thresholds by the language Jev answered, since that is what is being decided', () => {
    expect(answeredSlice(decided({ language: choice('roman-urdu', 0.8) }))).toBe('roman-urdu');
    expect(answeredSlice(decided({ language: choice('klingon', 0.8) }))).toBeNull();
    expect(DEFAULT_CHECK_THRESHOLDS.language?.['roman-urdu']).toEqual({
      language: { type: 'choice', minConfidence: 0.55 },
    });
    // A Hinglish answer was not reliable enough in the evaluation: never acted on.
    expect(DEFAULT_CHECK_THRESHOLDS.language?.hinglish).toBeUndefined();
  });

  it('settles only on a language the words fit, and only when sure enough for it', () => {
    expect(languageDecision(answered('roman-urdu', true), latin)).toBe('ur-Latn');
    expect(languageDecision(answered('roman-urdu', false), latin)).toBeNull();
    expect(languageDecision(answered('en', true), latin)).toBeNull();
  });

  it('settles an ambiguous message without asking, and never overrides the customer', () => {
    const detection = detectLanguage('mujhe order ka status batao');
    expect(detection.ambiguous).toBe(true);
    expect(resolveReplyLanguage({ detection, decided: 'ur-Latn' })).toEqual({
      language: 'ur-Latn',
      source: 'decided',
      confirm: null,
    });
    expect(resolveReplyLanguage({ detection, decided: 'en' }).source).not.toBe('decided');
    expect(resolveReplyLanguage({ detection, explicit: 'hi-Latn', decided: 'ur-Latn' })).toEqual({
      language: 'hi-Latn',
      source: 'explicit',
      confirm: null,
    });
    // Without a decision the customer is asked once, as before.
    expect(resolveReplyLanguage({ detection }).confirm).not.toBeNull();
  });
});

describe('message guard', () => {
  const yes = (probability = 0.95) => ({ type: 'noul' as const, probability, verdict: true });
  const no = (probability = 0.05) => ({ type: 'noul' as const, probability, verdict: false });
  const gatedWith = (kept: GatedAnswers['kept']): GatedAnswers => ({
    status: 'decided',
    reason: null,
    kept,
    shortfalls: {},
    observed: {},
  });
  const none = { paymentConfirmed: false, refundConfirmed: false, refundCommitted: false };

  it('asks each condition on its own, about the message or the reply', () => {
    expect(Object.keys(INBOUND_GUARD_QUESTIONS)).toEqual([
      'self_harm',
      'in_danger',
      'threat',
      'abuse',
    ]);
    expect(Object.keys(OUTBOUND_GUARD_QUESTIONS)).toEqual([
      'says_paid',
      'says_refunded',
      'says_order_changed',
      'promises_refund',
      'promises_order_change',
    ]);
    for (const question of [
      ...Object.values(INBOUND_GUARD_QUESTIONS),
      ...Object.values(OUTBOUND_GUARD_QUESTIONS),
    ]) {
      expect(question.type).toBe('noul');
      expect(question.outcomes.true).toBeTruthy();
      expect(question.outcomes.false).toBeTruthy();
    }
  });

  it('treats self-harm or danger now as urgent, and a threat or abuse as a hand-off', () => {
    expect(inboundGuardVerdict(gatedWith({ self_harm: yes(), threat: no() }))).toEqual({
      urgent: true,
      handoff: true,
      reasons: ['self_harm'],
    });
    expect(inboundGuardVerdict(gatedWith({ in_danger: yes() })).urgent).toBe(true);
    expect(inboundGuardVerdict(gatedWith({ threat: yes(), abuse: yes() }))).toEqual({
      urgent: false,
      handoff: true,
      reasons: ['threat', 'abuse'],
    });
    // An answer short of its threshold decides nothing.
    expect(inboundGuardVerdict(gatedWith({ self_harm: null, in_danger: no() }))).toEqual({
      urgent: false,
      handoff: false,
      reasons: [],
    });
  });

  it('has safe wording in every reply language that sends people to emergency help', () => {
    for (const language of REPLY_LANGUAGES)
      expect(SAFE_REPLIES[language].length).toBeGreaterThan(40);
    expect(SAFE_REPLIES.en).toContain('emergency number');
    expect(SAFE_REPLIES['ur-Latn']).toContain('emergency number');
  });

  it('has staff wording in every reply language: the same help, then that the team was told', () => {
    for (const language of REPLY_LANGUAGES) {
      const passedOn = splitSentences(SAFE_REPLIES[language]);
      const told = splitSentences(SAFE_REPLIES_STAFF[language]);
      // Only the closing sentence differs, so the help text cannot drift apart.
      expect(told, language).toHaveLength(passedOn.length);
      expect(told.slice(0, -1), language).toEqual(passedOn.slice(0, -1));
      expect(told.at(-1), language).not.toBe(passedOn.at(-1));
      expect(SAFE_REPLIES_STAFF[language]).not.toContain(passedOn.at(-1) ?? '');
    }
    expect(SAFE_REPLIES_STAFF.en).toContain('emergency number');
    expect(SAFE_REPLIES_STAFF.en).toMatch(
      /I have told our team, and a person will reply here as soon as they can\.$/,
    );
    expect(SAFE_REPLIES_STAFF.en).not.toContain('passed this chat');
  });

  it('lets a payment or refund stand only with its receipt, and a promised refund once submitted', () => {
    const claims = outboundClaims(
      gatedWith({ says_paid: yes(), says_refunded: no(), promises_refund: yes(), abuse: yes() }),
    );
    expect(claims).toEqual(['says_paid', 'promises_refund']);
    expect(unbackedClaims(claims, none)).toEqual(['says_paid', 'promises_refund']);
    expect(unbackedClaims(claims, { ...none, paymentConfirmed: true })).toEqual([
      'promises_refund',
    ]);
    expect(
      unbackedClaims(claims, { ...none, paymentConfirmed: true, refundCommitted: true }),
    ).toEqual([]);
    // A refund that succeeded backs the promise too; it does not back a payment.
    expect(
      unbackedClaims(['says_paid', 'promises_refund'], { ...none, refundConfirmed: true }),
    ).toEqual(['says_paid']);
  });

  it('never backs an order change that no AI action has a receipt for', () => {
    // Payment and refund receipts are not an order change's.
    const all = { paymentConfirmed: true, refundConfirmed: true, refundCommitted: true };
    expect(unbackedClaims(['says_order_changed', 'promises_order_change'], all)).toEqual([
      'says_order_changed',
      'promises_order_change',
    ]);
    // Unsure answers are not claims.
    expect(outboundClaims(gatedWith({ says_order_changed: null }))).toEqual([]);
  });

  it('backs an order change with the receipt of an AI action, and a promised one once it is on its way', () => {
    const claims = ['says_order_changed', 'promises_order_change'] as const;
    // Approved or sent and not settled: Hamnivo is committed, so the change may be promised, not said.
    expect(unbackedClaims(claims, { ...none, orderChange: 'committed' })).toEqual([
      'says_order_changed',
    ]);
    // A succeeded receipt backs both.
    expect(unbackedClaims(claims, { ...none, orderChange: 'confirmed' })).toEqual([]);
    // It backs neither a payment nor a refund.
    expect(
      unbackedClaims(['says_paid', 'says_refunded', 'promises_refund'], {
        ...none,
        orderChange: 'confirmed',
      }),
    ).toEqual(['says_paid', 'says_refunded', 'promises_refund']);
  });

  it('tells the model what it said or promised without a receipt', () => {
    const correction = outboundGuardCorrection(['says_refunded', 'promises_order_change']);
    expect(correction).toContain('said that a refund was made');
    expect(correction).toContain('promised a change to an order');
    expect(correction).toContain('not confirmed yet');
  });
});
