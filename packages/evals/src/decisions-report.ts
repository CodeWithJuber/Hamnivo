import {
  LANGUAGE_QUESTION,
  LANGUAGE_SLICES,
  PERSON_REQUEST_QUESTION,
  routingQuestion,
} from '@hamnivo/domain';
import type { ChoiceThresholdOutcome, NoulBand } from './calibration.js';
import type { ChoiceMetrics, DecisionsReport, LatencyMetrics, NoulMetrics } from './decisions.js';
import {
  CHAT_DEADLINE_MS,
  PERSON_REQUEST_FLOOR,
  PRICE_PER_MILLION_INPUT_TOKENS,
  thresholdsFrom,
} from './decisions.js';
import { formatRate, type Rate } from './stats.js';
import type { RoutingIntentSpec } from './types.js';

const SLICE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  hi: 'Hindi',
  ur: 'Urdu',
  hinglish: 'Hinglish',
  'roman-urdu': 'Roman Urdu',
};

const num = (value: number | null | undefined, places = 3) =>
  value === null || value === undefined ? '–' : value.toFixed(places);
const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : `${Math.round(value * 100)}%`;
const rate = (r: Rate) =>
  r.rate === null ? '–' : `${r.rate.toFixed(3)} (${r.successes}/${r.total})`;
const ms = (value: number | null) => (value === null ? '–' : `${value} ms`);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

const slices = (by: Record<string, unknown>) =>
  [...LANGUAGE_SLICES].filter((slice) => by[slice] !== undefined);

function threshold(t: ChoiceThresholdOutcome | null): [string, string, string] {
  if (!t) return ['none reaches 95%', '100%', '–'];
  return [num(t.minConfidence, 2), pct(t.abstention), num(t.accuracy)];
}

function choiceRows(by: Record<string, ChoiceMetrics>, overall: ChoiceMetrics): string[][] {
  const row = (name: string, m: ChoiceMetrics) => [
    name,
    String(m.items),
    rate(m.accuracy),
    rate(m.baselineAccuracy),
    num(m.brier),
    num(m.calibrationError),
    ...threshold(m.threshold),
  ];
  return [
    ...slices(by).map((slice) => row(SLICE_NAMES[slice] ?? slice, by[slice] as ChoiceMetrics)),
    row('**All**', overall),
  ];
}

function band(b: NoulBand | null): [string, string, string, string] {
  if (!b) return ['none reaches 95%', '100%', '–', '–'];
  return [
    `≥ ${num(b.trueAtLeast, 2)} / ≤ ${num(b.falseAtMost, 2)}`,
    pct(b.abstention),
    num(b.precision),
    num(b.recall),
  ];
}

function noulRows(by: Record<string, NoulMetrics>, overall: NoulMetrics): string[][] {
  const row = (name: string, m: NoulMetrics) => [
    name,
    `${m.items} (${m.positives})`,
    rate(m.accuracy),
    rate(m.baselineAccuracy),
    num(m.brier),
    num(m.calibrationError),
    ...band(m.band),
  ];
  return [
    ...slices(by).map((slice) => row(SLICE_NAMES[slice] ?? slice, by[slice] as NoulMetrics)),
    row('**All**', overall),
  ];
}

function latencyRows(by: Record<string, LatencyMetrics>, overall: LatencyMetrics): string[][] {
  const row = (name: string, m: LatencyMetrics) => [
    name,
    String(m.calls),
    ms(m.p50),
    ms(m.p95),
    String(m.overChatDeadline),
  ];
  return [
    ...slices(by).map((slice) => row(SLICE_NAMES[slice] ?? slice, by[slice] as LatencyMetrics)),
    row('**All**', overall),
  ];
}

function questionsBlock(rubric: readonly RoutingIntentSpec[]): string {
  const intent = routingQuestion(
    rubric.map((r) => ({ key: r.key, description: r.description, keywords: r.keywords })),
  );
  const show = {
    wants_person: PERSON_REQUEST_QUESTION,
    intent,
    language: LANGUAGE_QUESTION,
  };
  return ['```json', JSON.stringify(show, null, 2), '```'].join('\n');
}

/** The run as a Markdown report: corpus text and numbers only, never keys or request ids. */
export function decisionsMarkdown(
  report: DecisionsReport,
  meta: {
    date: string;
    command: string;
    concurrency: number;
    deadlineMs: number;
    corpusSizes: Record<string, number>;
    rubric: readonly RoutingIntentSpec[];
    maxErrors?: number;
    /** Where the run's answers are stored (ids and numbers, no text), when they are. */
    answers?: string;
  },
): string {
  const lines: string[] = [];
  const failures = Object.entries(report.failures);
  lines.push(`# ${report.model} on Hamnivo's decisions (${meta.date})`);
  lines.push('');
  lines.push(
    `Provider \`${report.provider}\`, model \`${report.model}\`${report.provider === 'jev' ? ' (pinned), through `@hamnivo/adapters/jev`' : ''}, with the questions the product asks. ` +
      `${report.items} messages, ${report.calls} calls (${meta.concurrency} at a time, ${meta.deadlineMs / 1000} s deadline per call), ` +
      `${report.tokens.input.toLocaleString('en')} input tokens, about $${report.tokens.costUsd.toFixed(4)} at $${PRICE_PER_MILLION_INPUT_TOKENS} per million input tokens (output is free).`,
  );
  lines.push('');
  lines.push(`Command: \`${meta.command}\``);
  lines.push('');
  if (meta.answers) {
    lines.push(
      `The answers are stored in \`${meta.answers}\` (corpus ids and numbers, no text): \`run-suite decisions --from ${meta.answers}\` scores them again without calling anyone.`,
    );
    lines.push('');
  }
  lines.push(
    failures.length === 0
      ? 'Every call was answered.'
      : `Calls not answered: ${failures.map(([k, v]) => `${k} ${v}`).join(', ')}. They are left out of the scores below.`,
  );
  lines.push('');
  const routingAll = report.routing.overall;
  const personAll = report.personRequest.overall;
  const languageAll = report.language.overall;
  const notUsed = Object.entries(report.language.byAnswer)
    .filter(([, m]) => m.threshold === null)
    .map(([label]) => SLICE_NAMES[label] ?? label);
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `- **Routing:** Jev chose the right topic for ${rate(routingAll.accuracy)} of the messages; the fixed keyword rule managed ${rate(routingAll.baselineAccuracy)}. Brier ${num(routingAll.brier)}, calibration error ${num(routingAll.calibrationError)}.`,
  );
  lines.push(
    `- **Request for a person:** ${rate(personAll.accuracy)} right at 0.5 (Brier ${num(personAll.brier)}); the fixed rule, which decides first, was right for ${rate(personAll.baselineAccuracy)} (its own test cases are part of the set). Jev only adds a hand-off from ${PERSON_REQUEST_FLOOR.toFixed(2)} up; its errors are listed below.`,
  );
  lines.push(
    `- **Language:** ${rate(languageAll.accuracy)}; Hinglish and Roman Urdu as one: ${rate(report.language.latinFamilyAccuracy)}. ${notUsed.length > 0 ? `Jev’s ${notUsed.join(' and ')} answer${notUsed.length > 1 ? 's are' : ' is'} not reliable enough to act on, so the product keeps asking the customer once when Latin-script Hindustani is ambiguous.` : ''}`,
  );
  lines.push(
    `- **Speed and cost:** p50 ${ms(report.latency.overall.p50)}, p95 ${ms(report.latency.overall.p95)}; ${report.latency.overall.overChatDeadline} of ${report.latency.overall.calls} calls took longer than the ${CHAT_DEADLINE_MS / 1000} s chat deadline. About ${report.tokens.perCall ?? '–'} input tokens per call, $${(((report.tokens.perCall ?? 0) * PRICE_PER_MILLION_INPUT_TOKENS) / 1e6).toFixed(7)} per decision.`,
  );
  lines.push(
    `- **U13 pairs:** ${report.consistency.consistent} of ${report.consistency.groups} groups got the same answer for every variant.`,
  );
  lines.push('');
  lines.push(
    'One run, about 40 messages per slice: enough to set starting thresholds and to see where Jev is weak, not to rank slices that differ by a few points. Thresholds hold only for `' +
      report.model +
      '` and these questions; a new Jev version needs a new run.',
  );
  lines.push('');
  lines.push('## What was measured');
  lines.push('');
  lines.push(
    '- **Request for a person** (`wants_person`, a noul): does the customer ask for a human? In the product a fixed rule decides first and always wins; Jev can only add a hand-off.',
  );
  lines.push(
    '- **Routing intent** (`intent`, a choice over the brand’s topics plus `other`): the team-routing question (J02).',
  );
  lines.push('- **Language** (`language`, a choice over the six language slices): U01.');
  lines.push('');
  lines.push(
    'Each message is one call with all three questions (Jev answers them in parallel, independently). The state is what routing sends: `{"messages": [<the message, personal data replaced by its kind>], "conversation": "with_ai"}`.',
  );
  lines.push('');
  lines.push(questionsBlock(meta.rubric));
  lines.push('');
  lines.push('## Corpora');
  lines.push('');
  for (const [name, size] of Object.entries(meta.corpusSizes)) lines.push(`- ${name}: ${size}`);
  lines.push('');
  lines.push(
    'Non-English text is pending review by native speakers. The routing corpus was written for this evaluation, not taken from customers. Some Hinglish and Roman Urdu messages read the same in both; they are kept, because the product has to handle that ambiguity (it asks the customer once).',
  );
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push(
    '"Accuracy" is the provider’s top answer (a noul at 0.5); "fixed rule" is the product’s deterministic rule on the same messages, which decides whenever Jev abstains. Rates show the 95% Wilson interval in the JSON results; with about 40 messages per slice, differences of a few points are not meaningful. Brier: lower is better (0 is perfect). Calibration error: expected calibration error over 10 bins.',
  );
  lines.push('');
  lines.push('### Request for a person');
  lines.push('');
  lines.push(
    table(
      [
        'Slice',
        'Messages (asking)',
        'Accuracy',
        'Fixed rule',
        'Brier',
        'Calibration error',
        'Band',
        'Abstained',
        'Precision',
        'Recall',
      ],
      noulRows(report.personRequest.bySlice, report.personRequest.overall),
    ),
  );
  lines.push('');
  lines.push(
    `Band: Jev’s answer counts as "asks for a person" at or above the first number and as "does not" at or below the second; between them it abstains. Chosen as the lowest bound from ${PERSON_REQUEST_FLOOR.toFixed(2)} up whose "asks" answers were at least 95% right, and the highest "does not" bound at 95%. The floor is there because Jev can only add a hand-off the fixed rule missed, and a needless one makes the customer wait for a person.`,
  );
  lines.push('');
  lines.push(
    'The fixed rule is perfect here by construction: the hand-off fixtures are its own test cases, and the routing messages contain no request for a person. What matters is where Jev disagrees with it, because Jev only ever adds a hand-off the fixed rule missed.',
  );
  lines.push('');
  lines.push('### Routing intent');
  lines.push('');
  lines.push(
    table(
      [
        'Slice',
        'Messages',
        'Accuracy',
        'Fixed rule',
        'Brier',
        'Calibration error',
        'Threshold',
        'Abstained',
        'Accuracy when decided',
      ],
      choiceRows(report.routing.bySlice, report.routing.overall),
    ),
  );
  lines.push('');
  lines.push(
    'Threshold: the lowest confidence (0.50 to 0.95 in steps of 0.05) at which at least 10 of Jev’s answers were decided and at least 95% of them were right. Below it Jev abstains and the fixed rule routes.',
  );
  lines.push('');
  lines.push('### Language');
  lines.push('');
  lines.push(
    table(
      [
        'Slice',
        'Messages',
        'Accuracy',
        'Fixed rule',
        'Brier',
        'Calibration error',
        'Threshold',
        'Abstained',
        'Accuracy when decided',
      ],
      choiceRows(report.language.bySlice, report.language.overall),
    ),
  );
  lines.push('');
  lines.push(
    `Hinglish and Roman Urdu counted as one answer (Latin-script Hindustani): ${formatRate(report.language.latinFamilyAccuracy)}. The fixed rule’s "accuracy" counts an ambiguous answer (it asks the customer) as wrong.`,
  );
  lines.push('');
  lines.push(
    'When the product decides, it does not know the language yet: that is the question. So its thresholds are per language Jev answered. The share of each answer that was right:',
  );
  lines.push('');
  lines.push(
    table(
      [
        'Jev answered',
        'Answers',
        'Right',
        'Brier',
        'Calibration error',
        'Threshold',
        'Set aside',
        'Right when used',
      ],
      slices(report.language.byAnswer).map((slice) => {
        const m = report.language.byAnswer[slice] as ChoiceMetrics;
        return [
          SLICE_NAMES[slice] ?? slice,
          String(m.items),
          rate(m.accuracy),
          num(m.brier),
          num(m.calibrationError),
          ...threshold(m.threshold),
        ];
      }),
    ),
  );
  lines.push('');
  lines.push('### Latency and cost');
  lines.push('');
  lines.push(
    table(
      ['Slice', 'Calls', 'p50', 'p95', `Over ${CHAT_DEADLINE_MS / 1000} s`],
      latencyRows(report.latency.bySlice, report.latency.overall),
    ),
  );
  lines.push('');
  lines.push(
    `Input tokens: ${report.tokens.input.toLocaleString('en')} in total, ${report.tokens.perCall ?? '–'} per call. Output tokens (free): ${report.tokens.output.toLocaleString('en')}. Cost: $${report.tokens.costUsd.toFixed(4)} for the run, about $${(((report.tokens.perCall ?? 0) * PRICE_PER_MILLION_INPUT_TOKENS) / 1e6).toFixed(7)} per decision.`,
  );
  lines.push('');
  const defaults = thresholdsFrom(report);
  lines.push('### Defaults set from this run');
  lines.push('');
  lines.push(
    `\`DEFAULT_DECISION_THRESHOLDS\` in \`@hamnivo/domain\` holds these for \`${defaults.model}\`; a language without one was not supported by the data, so Jev abstains there and the fixed rule decides.`,
  );
  lines.push('');
  lines.push(
    table(
      [
        'Slice',
        'Routing: minimum confidence',
        'Request for a person: band',
        'Language: minimum confidence (by answer)',
      ],
      [...LANGUAGE_SLICES].map((slice) => {
        const band = defaults.personRequest[slice];
        return [
          SLICE_NAMES[slice] ?? slice,
          num(defaults.routing[slice] ?? null, 2),
          band ? `≥ ${band.trueAtLeast.toFixed(2)} / ≤ ${band.falseAtMost.toFixed(2)}` : '–',
          num(defaults.language[slice] ?? null, 2),
        ];
      }),
    ),
  );
  lines.push('');
  lines.push('### U13 pairs');
  lines.push('');
  lines.push(
    `${report.consistency.consistent} of ${report.consistency.groups} groups got the same answer for every variant (names, gender markers, politeness, script and language swapped).`,
  );
  for (const finding of report.consistency.findings) lines.push(`- ${cell(finding)}`);
  lines.push('');
  const maxErrors = meta.maxErrors ?? 40;
  lines.push(
    `## Errors (${report.errors.length}, the ${Math.min(maxErrors, report.errors.length)} most confident shown)`,
  );
  lines.push('');
  if (report.errors.length === 0) lines.push('None.');
  else
    lines.push(
      table(
        ['Task', 'Slice', 'Message', 'Expected', 'Jev', 'Confidence'],
        [...report.errors]
          .sort((a, b) => b.score - a.score)
          .slice(0, maxErrors)
          .map((e) => [
            e.task,
            SLICE_NAMES[e.slice] ?? e.slice,
            cell(e.text),
            e.expected,
            e.got,
            num(e.score, 2),
          ]),
      ),
    );
  lines.push('');
  return `${lines.join('\n')}\n`;
}
