import {
  LANGUAGE_QUESTION,
  LANGUAGE_SLICES,
  PERSON_REQUEST_QUESTION,
  routingQuestion,
} from '@hamnivo/domain';
import type { ChoiceThresholdOutcome, NoulBand } from './calibration.js';
import type { ChoiceMetrics, DecisionsReport, LatencyMetrics, NoulMetrics } from './decisions.js';
import { CHAT_DEADLINE_MS, PRICE_PER_MILLION_INPUT_TOKENS } from './decisions.js';
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
  if (!t) return ['none reaches 90%', '100%', '–'];
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
  lines.push(
    failures.length === 0
      ? 'Every call was answered.'
      : `Calls not answered: ${failures.map(([k, v]) => `${k} ${v}`).join(', ')}. They are left out of the scores below.`,
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
    'Band: Jev’s answer counts as "asks for a person" at or above the first number and as "does not" at or below the second; between them it abstains. Chosen as the lowest bound whose "asks" answers were at least 95% right (and the highest "does not" bound at 95%).',
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
    'Threshold: the lowest confidence (0.30 to 0.95 in steps of 0.05) at which Jev’s decided answers were at least 90% right. Below it Jev abstains and the fixed rule routes.',
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
