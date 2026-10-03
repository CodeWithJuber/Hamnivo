import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { FlaskConicalIcon, RotateCcwIcon, SendIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { aiPowerEn } from '../../i18n/ai-power/en';
import type { PlaygroundAction, PlaygroundResult, PlaygroundStep } from '../../lib/ai-power';
import { api } from '../../lib/api';
import { formatDuration, formatNumber } from '../../lib/format';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { StepStatusBadge } from '../Badges';
import { SelectField, TextareaField } from '../Fields';
import { ActionError } from '../States';

type Version = 'draft' | 'published';

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** What the AI did, for its own turns. */
  result?: PlaygroundResult;
}

/** The most the server takes in one conversation; one is kept free for the next question. */
const MAX_MESSAGES = 20;

type ErrorKind = keyof typeof aiPowerEn.playground.errors;
type OutcomeKey = keyof typeof aiPowerEn.playground.outcome;
const ERROR_KINDS = new Set<string>(Object.keys(aiPowerEn.playground.errors));
const OUTCOME_KEYS = new Set<string>(Object.keys(aiPowerEn.playground.outcome));

/** What went wrong, as one of the kinds there are words for. */
const errorKindOf = (kind: string | null): ErrorKind =>
  kind && ERROR_KINDS.has(kind) ? (kind as ErrorKind) : 'unknown';

/** Why a live chat would go to people, as one of the reasons there are words for. */
const outcomeKeyOf = (reason: string | null): OutcomeKey =>
  reason && OUTCOME_KEYS.has(reason) ? (reason as OutcomeKey) : 'other';

const decisionTone: Record<PlaygroundAction['decision'], StatusTone> = {
  would_run: 'success',
  needs_approval: 'info',
  denied: 'warning',
  invalid: 'danger',
};

/** A fact of a step as one line: numbers and words as they are, anything else as JSON. */
function Fact({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-text-muted">—</span>;
  if (typeof value === 'object') {
    return <code className="hv-code block text-xs">{JSON.stringify(value)}</code>;
  }
  return (
    <bdi dir="ltr" className="font-mono text-xs break-all">
      {String(value)}
    </bdi>
  );
}

function Step({ step }: { step: PlaygroundStep }) {
  const { t } = useTranslation();
  const facts = Object.entries(step.detail);
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border p-2" data-step={step.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary">{step.seq + 1}</span>
        <StatusBadge tone="neutral" icon={null}>
          {t(`runs.detail.stepKinds.${step.kind}`)}
        </StatusBadge>
        <StepStatusBadge status={step.status} />
        <bdi dir="ltr" className="font-mono text-xs">
          {step.name}
        </bdi>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {step.provider || step.modelId ? (
          <>
            <dt className="text-text-secondary">{t('runs.columns.model')}</dt>
            <dd>
              <bdi dir="ltr" className="font-mono">
                {[step.provider, step.modelId].filter(Boolean).join(' / ')}
              </bdi>
            </dd>
          </>
        ) : null}
        {step.inputTokens !== null || step.outputTokens !== null ? (
          <>
            <dt className="text-text-secondary">{t('runs.columns.tokens')}</dt>
            <dd>
              {formatNumber(step.inputTokens)} / {formatNumber(step.outputTokens)}
            </dd>
          </>
        ) : null}
        {step.latencyMs !== null ? (
          <>
            <dt className="text-text-secondary">{t('runs.columns.latency')}</dt>
            <dd>{formatDuration(step.latencyMs)}</dd>
          </>
        ) : null}
        {facts.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-text-secondary">
              <bdi dir="ltr" className="font-mono">
                {key}
              </bdi>
            </dt>
            <dd className="min-w-0">
              <Fact value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/** What the AI said or did for one message of the tester, with everything behind it. */
export function PlaygroundAnswer({ result }: { result: PlaygroundResult }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      {result.outcome === 'replied' && result.reply ? (
        <p
          className="text-sm whitespace-pre-line text-text"
          dir="auto"
          data-testid="playground-reply"
        >
          {result.reply}
        </p>
      ) : result.outcome === 'error' ? (
        <p className="text-sm text-danger" role="alert" data-testid="playground-error">
          {t(`aiPower.playground.errors.${errorKindOf(result.errorKind)}`)}
        </p>
      ) : (
        <p className="text-sm text-text" data-testid="playground-handoff">
          {t(`aiPower.playground.outcome.${outcomeKeyOf(result.handoffReason)}`)}
        </p>
      )}

      {result.sources.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-text-secondary">
            {t('aiPower.playground.sources')}
          </h4>
          <ol className="flex flex-col gap-1 text-sm" data-testid="playground-sources">
            {result.sources.map((source, index) => (
              <li key={source.documentId} className="flex gap-2">
                <span className="text-text-secondary">{`[${index + 1}]`}</span>
                <span className="min-w-0">
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-link underline underline-offset-4 hover:no-underline"
                    >
                      <bdi>{source.title}</bdi>
                    </a>
                  ) : (
                    <bdi>{source.title}</bdi>
                  )}
                  {source.heading ? (
                    <span className="text-text-secondary">
                      {' '}
                      · <bdi>{source.heading}</bdi>
                    </span>
                  ) : null}
                  <span className="block text-xs text-text-secondary">
                    <bdi dir="auto">{source.excerpt}</bdi>
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {result.actions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-text-secondary">
            {t('aiPower.playground.actions')}
          </h4>
          <p className="text-xs text-text-secondary">{t('aiPower.playground.actionsNote')}</p>
          <ul className="flex flex-col gap-2" data-testid="playground-actions">
            {result.actions.map((action, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the calls are an ordered record of one answer
              <li key={index} className="flex flex-col gap-1 rounded-md border border-border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    <bdi>{action.title}</bdi>
                  </span>
                  <StatusBadge tone={decisionTone[action.decision]} data-decision={action.decision}>
                    {t(`aiPower.playground.decisions.${action.decision}`)}
                  </StatusBadge>
                </div>
                {action.arguments ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-text-secondary">
                      {t('aiPower.playground.details')}
                    </summary>
                    <code className="hv-code mt-1 block">
                      {JSON.stringify(action.arguments, null, 2)}
                    </code>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-text-secondary" data-testid="playground-stats">
        {result.model
          ? t('aiPower.playground.stats', {
              model: `${result.model.provider} / ${result.model.modelId}`,
              input: formatNumber(result.inputTokens),
              output: formatNumber(result.outputTokens),
              time: formatDuration(result.latencyMs),
            })
          : t('aiPower.playground.statsNoModel', { time: formatDuration(result.latencyMs) })}
      </p>

      <details className="text-sm" data-testid="playground-steps">
        <summary className="cursor-pointer text-text-secondary">
          {t('aiPower.playground.steps', { total: formatNumber(result.steps.length) })}
        </summary>
        <ol className="mt-2 flex flex-col gap-2" aria-label={t('aiPower.playground.stepsLabel')}>
          {result.steps.map((step) => (
            <Step key={step.seq} step={step} />
          ))}
        </ol>
      </details>
    </div>
  );
}

/**
 * "Test your AI" (G03, G11): a scratch conversation with the agent in the editor, run with the
 * model connection it really has. The conversation lives only in this page and is sent whole with
 * each message; nothing is stored, nothing reaches a customer or the inbox, and no tool is run.
 */
export function AgentPlayground({
  agentId,
  draftVersion,
  publishedVersion,
  unsaved,
}: {
  agentId: string;
  /** The saved draft's version number, when there is a saved draft. */
  draftVersion: number | undefined;
  /** The live version's number, when one is live. */
  publishedVersion: number | null;
  /** The form has changes that are not saved: the test cannot see them. */
  unsaved: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [version, setVersion] = useState<Version>(
    draftVersion !== undefined ? 'draft' : 'published',
  );
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const run = useStudioMutation(
    (
      body: { version: Version; messages: { role: 'user' | 'assistant'; text: string }[] },
      tenant,
    ) =>
      api<PlaygroundResult>(`/v1/admin/agents/${agentId}/playground`, {
        method: 'POST',
        tenant,
        body,
      }),
  );

  if (!can('agents.manage')) return null;
  const available = draftVersion !== undefined || publishedVersion !== null;
  // What the server is sent: the person's messages and the AI's replies, in order.
  const history = turns.flatMap((turn): { role: 'user' | 'assistant'; text: string }[] =>
    turn.role === 'user' || turn.result?.reply ? [{ role: turn.role, text: turn.text }] : [],
  );
  const full = history.length >= MAX_MESSAGES;
  const chosen: Version =
    version === 'draft' && draftVersion === undefined
      ? 'published'
      : version === 'published' && publishedVersion === null
        ? 'draft'
        : version;

  const send = async () => {
    const message = text.trim();
    if (!message || pending !== null || full) return;
    setFailure(null);
    setPending(message);
    setText('');
    try {
      const result = await run.mutateAsync({
        version: chosen,
        messages: [...history, { role: 'user', text: message }],
      });
      const next = turns.length;
      setTurns([
        ...turns,
        { id: next, role: 'user', text: message },
        { id: next + 1, role: 'assistant', text: result.reply ?? '', result },
      ]);
      announce(
        result.reply ??
          (result.outcome === 'error'
            ? t(`aiPower.playground.errors.${errorKindOf(result.errorKind)}`)
            : t(`aiPower.playground.outcome.${outcomeKeyOf(result.handoffReason)}`)),
      );
    } catch (caught) {
      // The message goes back into the box so nothing typed is lost.
      setText(message);
      if (!isCancelled(caught)) setFailure(caught);
    } finally {
      setPending(null);
    }
  };

  const options = [
    ...(draftVersion !== undefined
      ? [
          {
            value: 'draft',
            label: t('aiPower.playground.versions.draft', { version: draftVersion }),
          },
        ]
      : []),
    ...(publishedVersion !== null
      ? [
          {
            value: 'published',
            label: t('aiPower.playground.versions.published', { version: publishedVersion }),
          },
        ]
      : []),
  ];

  return (
    <section
      aria-labelledby="playground-title"
      data-testid="playground"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="playground-title" className="text-lg font-semibold text-text">
          {t('aiPower.playground.title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('aiPower.playground.description')}</p>
      </div>

      {!available ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-sm text-text-secondary">
          {t('aiPower.playground.noVersion')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60">
              <SelectField
                id="playground-version"
                label={t('aiPower.playground.version')}
                value={chosen}
                onChange={(event) => {
                  setVersion(event.target.value as Version);
                  setTurns([]);
                  setFailure(null);
                }}
                options={options}
              />
            </div>
            <StatusBadge
              tone="neutral"
              icon={<FlaskConicalIcon className="size-3.5" aria-hidden="true" />}
            >
              {t('aiPower.playground.testOnly')}
            </StatusBadge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={turns.length === 0 || pending !== null}
              onClick={() => {
                setTurns([]);
                setFailure(null);
                setText('');
              }}
            >
              <RotateCcwIcon aria-hidden="true" />
              {t('aiPower.playground.startOver')}
            </Button>
          </div>
          {unsaved && chosen === 'draft' ? (
            <p className="text-sm text-warning" data-testid="playground-unsaved">
              {t('aiPower.playground.unsaved')}
            </p>
          ) : null}

          <div
            role="log"
            aria-label={t('aiPower.playground.title')}
            aria-live="polite"
            className="flex flex-col gap-3"
            data-testid="playground-transcript"
          >
            {turns.length === 0 && pending === null ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-sm text-text-secondary">
                {t('aiPower.playground.empty')}
              </p>
            ) : null}
            {turns.map((turn) => (
              <div
                key={turn.id}
                data-role={turn.role}
                className={
                  turn.role === 'user'
                    ? 'ms-auto flex max-w-[85%] flex-col gap-1 rounded-lg bg-brand-subtle p-3'
                    : 'me-auto flex w-full max-w-[95%] flex-col gap-1 rounded-lg border border-border p-3'
                }
              >
                <span className="text-xs font-medium text-text-secondary">
                  {turn.role === 'user' ? t('aiPower.playground.you') : t('aiPower.playground.ai')}
                </span>
                {turn.role === 'user' ? (
                  <p className="text-sm whitespace-pre-line text-text" dir="auto">
                    {turn.text}
                  </p>
                ) : turn.result ? (
                  <PlaygroundAnswer result={turn.result} />
                ) : null}
              </div>
            ))}
            {pending !== null ? (
              <>
                <div
                  data-role="user"
                  className="ms-auto flex max-w-[85%] flex-col gap-1 rounded-lg bg-brand-subtle p-3"
                >
                  <span className="text-xs font-medium text-text-secondary">
                    {t('aiPower.playground.you')}
                  </span>
                  <p className="text-sm whitespace-pre-line text-text" dir="auto">
                    {pending}
                  </p>
                </div>
                <p className="text-sm text-text-secondary" role="status">
                  {t('aiPower.playground.thinking')}
                </p>
              </>
            ) : null}
          </div>

          <ActionError error={failure} />
          {full ? (
            <p className="text-sm text-text-secondary">{t('aiPower.playground.tooLong')}</p>
          ) : null}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            noValidate
          >
            <TextareaField
              id="playground-message"
              label={t('aiPower.playground.message')}
              hint={t('aiPower.playground.messageHint')}
              value={text}
              rows={2}
              maxLength={2000}
              dir="auto"
              disabled={full}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              type="submit"
              className="self-start"
              busy={pending !== null}
              disabled={!text.trim() || full}
            >
              {pending === null ? (
                <SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
              ) : null}
              {t('aiPower.playground.send')}
            </Button>
          </form>
        </>
      )}
    </section>
  );
}
