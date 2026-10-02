/**
 * Offline evaluation runs and their metrics.
 *
 *   pnpm --filter @hamnivo/evals run-suite sycophancy [--responder reference|sycophant|mock|model] [--out DIR]
 *   pnpm --filter @hamnivo/evals run-suite fairness [--out DIR]
 *   pnpm --filter @hamnivo/evals run-suite adjudication [--responder …] [--out DIR]
 *   pnpm --filter @hamnivo/evals run-suite summarize DIR
 *   pnpm --filter @hamnivo/evals run-suite decisions --provider jev|mock [--max-calls 2000]
 *       [--concurrency 4] [--model jev-1.13.0] [--report FILE.md] [--out DIR]
 *
 * `model` uses EVAL_MODEL_PROVIDER, EVAL_MODEL_ID and, where the provider needs them,
 * EVAL_MODEL_API_KEY and EVAL_MODEL_BASE_URL. `decisions --provider jev` uses TYPESAFE_API_KEY
 * (and TYPESAFE_BASE_URL when set). Keys come only from the environment and are never written
 * anywhere. Results hold the corpus text and the replies, never customer data.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createJevDecisionProvider } from '@hamnivo/adapters/jev';
import { createLanguageModel, createMockModel, type ModelSpec } from '@hamnivo/adapters/models';
import {
  createMockDecisionProvider,
  type DecisionProvider,
  EVALUATED_DECISION_MODEL,
} from '@hamnivo/domain';
import {
  buildReviewPackets,
  type ReviewPacket,
  reviewSheet,
  summarizeAdjudication,
} from './adjudication.js';
import { loadAdjudicationCorpus, loadFairnessCorpus, loadSycophancyCorpus } from './corpus.js';
import {
  DEFAULT_MAX_CALLS,
  decisionItems,
  loadHumanRequestCases,
  loadRoutingCorpus,
  runDecisions,
  scoreDecisions,
} from './decisions.js';
import { decisionsMarkdown } from './decisions-report.js';
import { runFairness } from './fairness.js';
import { modelResponder, referenceResponder, sycophantResponder } from './responders.js';
import { formatRate, groupBy } from './stats.js';
import { runSycophancy } from './sycophancy.js';
import type { Responder } from './types.js';

function responderFrom(name: string): Responder {
  switch (name) {
    case 'reference':
      return referenceResponder;
    case 'sycophant':
      return sycophantResponder;
    case 'mock':
      return modelResponder(createMockModel(), 'mock-model');
    case 'model': {
      const provider = process.env.EVAL_MODEL_PROVIDER as ModelSpec['provider'] | undefined;
      const modelId = process.env.EVAL_MODEL_ID;
      if (!provider || !modelId) {
        throw new Error('Set EVAL_MODEL_PROVIDER and EVAL_MODEL_ID to evaluate a model.');
      }
      const spec: ModelSpec = {
        provider,
        modelId,
        ...(process.env.EVAL_MODEL_API_KEY ? { apiKey: process.env.EVAL_MODEL_API_KEY } : {}),
        ...(process.env.EVAL_MODEL_BASE_URL ? { baseURL: process.env.EVAL_MODEL_BASE_URL } : {}),
      };
      return modelResponder(createLanguageModel(spec), `${provider}/${modelId}`);
    }
    default:
      throw new Error(`Unknown responder "${name}". Use reference, sycophant, mock or model.`);
  }
}

/** A provider for `decisions`: the mock answers from keywords, Jev from TypeSafe's API. */
function decisionProviderFrom(name: string, model: string): DecisionProvider {
  switch (name) {
    case 'mock': {
      const rubric = [...loadRoutingCorpus().rubric, ...loadFairnessCorpus().rubric];
      const keywords: Record<string, string[]> = {};
      for (const intent of rubric) {
        keywords[intent.key] = [...(keywords[intent.key] ?? []), ...intent.keywords];
      }
      return createMockDecisionProvider({
        rules: {
          wants_person: {
            type: 'noul',
            keywords: [
              'person',
              'human',
              'agent',
              'insaan',
              'banda',
              'bande',
              'banday',
              'موظف',
              'इंसान',
            ],
          },
          intent: { type: 'choice', keywords },
        },
      });
    }
    case 'jev': {
      const apiKey = process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          'Set TYPESAFE_API_KEY to evaluate Jev. It is read from the environment only.',
        );
      }
      const baseURL = process.env.TYPESAFE_BASE_URL?.trim() || undefined;
      return createJevDecisionProvider({
        apiKey,
        model,
        deadlineMs: 5000,
        // An evaluation should report failures, not stop at the first few of them.
        breaker: { failureThreshold: 25, cooldownMs: 5000 },
        ...(baseURL ? { baseURL } : {}),
      });
    }
    default:
      throw new Error(`Unknown decision provider "${name}". Use jev or mock.`);
  }
}

function write(dir: string, file: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
  return join(dir, file);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
/** Report lines go to standard output. */
const say = (line: string) => process.stdout.write(`${line}\n`);

function readPackets(dir: string): ReviewPacket[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as ReviewPacket[]);
}

function printAdjudication(packets: ReviewPacket[]) {
  const summary = summarizeAdjudication(packets);
  say(`adjudication: ${summary.cases} cases, ${summary.pending} pending native review`);
  for (const [slice, s] of Object.entries(summary.bySlice)) {
    say(
      `  ${slice.padEnd(11)} language chosen ${formatRate(s.auto.languageChosen)} · reply language ${formatRate(s.auto.replyLanguage)} · facts ${formatRate(s.auto.facts)} · meaning ${s.reviewed ? formatRate(s.meaningCorrect) : 'pending native review'}`,
    );
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      responder: { type: 'string', default: 'reference' },
      out: { type: 'string', default: resolve(import.meta.dirname, '../out') },
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string', default: EVALUATED_DECISION_MODEL },
      'max-calls': { type: 'string', default: String(DEFAULT_MAX_CALLS) },
      concurrency: { type: 'string', default: '4' },
      report: { type: 'string' },
    },
  });
  const [suite, target] = positionals;
  const out = resolve(values.out);
  switch (suite) {
    case 'sycophancy': {
      const report = await runSycophancy(loadSycophancyCorpus(), responderFrom(values.responder));
      const file = write(
        out,
        `sycophancy-${report.responder.replace(/\W+/g, '_')}.json`,
        json(report),
      );
      say(
        `sycophancy (${report.responder}): ${report.scenarios} scenarios, ${report.cases.length} cases`,
      );
      say(`  baseline holds       ${formatRate(report.baseline.holds)}`);
      say(`  pressure holds       ${formatRate(report.underPressure.holds)}`);
      say(`  pressure capitulates ${formatRate(report.underPressure.capitulates)}`);
      say(`  stance flipped       ${formatRate(report.flipped)}`);
      for (const [kind, r] of Object.entries(report.byPressure)) {
        say(`    ${kind.padEnd(16)} capitulates ${formatRate(r.capitulates)}`);
      }
      say(`written to ${file}`);
      break;
    }
    case 'fairness': {
      const report = runFairness(loadFairnessCorpus());
      const file = write(out, 'fairness.json', json(report));
      say(`fairness: ${report.groups.length} groups`);
      say(
        `  consistent ${formatRate(report.consistency)} · as expected ${formatRate(report.accuracy)}`,
      );
      for (const [attribute, r] of Object.entries(report.byAttribute)) {
        say(`    ${attribute.padEnd(11)} consistent ${formatRate(r.consistency)}`);
      }
      for (const f of report.findings) {
        say(
          `  finding: ${f.group}/${f.variant} (${f.slice}) got ${f.outcome}, expected ${f.expected}`,
        );
      }
      say(`written to ${file}`);
      break;
    }
    case 'adjudication': {
      const responder = responderFrom(values.responder);
      const packets = await buildReviewPackets(loadAdjudicationCorpus(), responder);
      const dir = join(out, `adjudication-${responder.name.replace(/\W+/g, '_')}`);
      for (const [slice, list] of groupBy(packets, (p) => p.slice)) {
        write(dir, `${slice}.json`, json(list));
        write(dir, `${slice}.md`, reviewSheet(slice, list));
      }
      printAdjudication(packets);
      say(`review packets in ${dir} (pending native review)`);
      break;
    }
    case 'decisions': {
      const maxCalls = Number(values['max-calls']);
      const concurrency = Number(values.concurrency);
      if (!(maxCalls > 0) || !(concurrency > 0 && concurrency <= 16)) {
        throw new Error('--max-calls must be positive and --concurrency between 1 and 16.');
      }
      const provider = decisionProviderFrom(values.provider, values.model);
      const routing = loadRoutingCorpus();
      const handoff = loadHumanRequestCases();
      const fairness = loadFairnessCorpus();
      const items = decisionItems(routing, handoff, fairness);
      const model = values.provider === 'jev' ? values.model : 'decision-mock-1';
      const deadlineMs = 5000;
      say(
        `decisions (${provider.id} ${model}): ${items.length} messages, at most ${maxCalls} calls`,
      );
      const { records, calls } = await runDecisions(items, {
        provider,
        model,
        maxCalls,
        concurrency,
        deadlineMs,
        onProgress: (done, total) => {
          if (done % 50 === 0 || done === total) say(`  ${done}/${total}`);
        },
      });
      const report = scoreDecisions(items, records, { provider: provider.id, model, calls });
      const file = write(
        out,
        `decisions-${provider.id}.json`,
        json({ report, records: records.map((r, i) => ({ ...r, text: items[i]?.text })) }),
      );
      say(
        `  person request: accuracy ${formatRate(report.personRequest.overall.accuracy)} · fixed rule ${formatRate(report.personRequest.overall.baselineAccuracy)}`,
      );
      say(
        `  routing:        accuracy ${formatRate(report.routing.overall.accuracy)} · fixed rule ${formatRate(report.routing.overall.baselineAccuracy)}`,
      );
      say(
        `  language:       accuracy ${formatRate(report.language.overall.accuracy)} · fixed rule ${formatRate(report.language.overall.baselineAccuracy)}`,
      );
      say(
        `  latency p50 ${report.latency.overall.p50} ms, p95 ${report.latency.overall.p95} ms · ${calls} calls · ${report.tokens.input} input tokens · $${report.tokens.costUsd}`,
      );
      say(`written to ${file}`);
      if (values.report) {
        const target = resolve(values.report);
        const date = new Date().toISOString().slice(0, 10);
        mkdirSync(resolve(target, '..'), { recursive: true });
        writeFileSync(
          target,
          decisionsMarkdown(report, {
            date,
            command: `pnpm --filter @hamnivo/evals run-suite decisions --provider ${values.provider} --model ${model} --max-calls ${maxCalls} --concurrency ${concurrency}`,
            concurrency,
            deadlineMs,
            corpusSizes: {
              'Routing corpus (`packages/evals/corpus/decisions-routing.json`, written for this evaluation)':
                routing.items.length,
              'Hand-off fixtures (`packages/domain/test/fixtures/human-requests.json`)':
                handoff.length,
              'U13 pairs (`packages/evals/corpus/fairness.json`, routing and hand-off groups)':
                items.filter((i) => i.source === 'fairness').length,
            },
            rubric: routing.rubric,
          }),
        );
        say(`report written to ${target}`);
      }
      break;
    }
    case 'summarize': {
      if (!target) throw new Error('summarize needs the packet directory');
      printAdjudication(readPackets(resolve(target)));
      break;
    }
    default:
      throw new Error(
        'Choose a suite: sycophancy, fairness, adjudication, decisions or summarize.',
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
