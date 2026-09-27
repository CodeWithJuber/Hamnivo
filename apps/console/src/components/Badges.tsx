import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { ClockIcon, GlobeIcon, Loader2Icon, LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  Agent,
  AuthorityConnection,
  DocumentVersion,
  KnowledgeDocument,
  KnowledgeSource,
  Run,
  RunStep,
} from '../lib/types';

/** Every badge pairs text with an icon; colour only repeats what the words say. */

export function ConnectionBadge({ status }: { status: AuthorityConnection['status'] | 'none' }) {
  const { t } = useTranslation();
  const tone: Record<typeof status, StatusTone> = {
    active: 'success',
    provisioning: 'info',
    degraded: 'warning',
    disabled: 'neutral',
    none: 'neutral',
  };
  return (
    <StatusBadge tone={tone[status]} data-status={status}>
      {t(`status.connection.${status}`)}
    </StatusBadge>
  );
}

export function AgentBadge({ agent }: { agent: Agent | undefined }) {
  const { t } = useTranslation();
  if (!agent) return <StatusBadge tone="neutral">{t('status.agent.none')}</StatusBadge>;
  if (agent.status === 'archived') {
    return <StatusBadge tone="neutral">{t('status.agent.archived')}</StatusBadge>;
  }
  if (agent.publishedVersion === null) {
    return (
      <StatusBadge tone="warning" data-status="draft-only">
        {t('status.agent.draftOnly')}
      </StatusBadge>
    );
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      <StatusBadge tone="success" data-status="live">
        {t('status.agent.live', { version: agent.publishedVersion })}
      </StatusBadge>
      {agent.draftVersion !== null ? (
        <StatusBadge tone="info">
          {t('status.agent.draftAhead', { version: agent.draftVersion })}
        </StatusBadge>
      ) : null}
    </span>
  );
}

const versionTone: Record<DocumentVersion['state'], StatusTone> = {
  queued: 'neutral',
  processing: 'info',
  ready: 'success',
  failed: 'danger',
  rejected: 'danger',
  superseded: 'neutral',
};

export function VersionStateBadge({ state }: { state: DocumentVersion['state'] }) {
  const { t } = useTranslation();
  const icon =
    state === 'queued' ? (
      <ClockIcon className="size-3.5" aria-hidden="true" />
    ) : state === 'processing' ? (
      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
    ) : undefined;
  return (
    <StatusBadge tone={versionTone[state]} icon={icon} data-state={state}>
      {t(`knowledge.state.${state}`)}
    </StatusBadge>
  );
}

/**
 * The honest state of a document: the newest upload while it is being processed or was refused,
 * otherwise the version answers use.
 */
export function documentState(document: KnowledgeDocument): DocumentVersion['state'] | 'retired' {
  if (document.status === 'retired') return 'retired';
  return document.latest?.state ?? document.current?.state ?? 'queued';
}

export function DocumentStateBadge({ document }: { document: KnowledgeDocument }) {
  const { t } = useTranslation();
  const state = documentState(document);
  if (state === 'retired') {
    return (
      <StatusBadge tone="neutral" data-state="retired">
        {t('knowledge.state.retired')}
      </StatusBadge>
    );
  }
  return <VersionStateBadge state={state} />;
}

export function FreshnessBadge({ freshness }: { freshness: KnowledgeDocument['freshness'] }) {
  const { t } = useTranslation();
  const tone: Record<typeof freshness, StatusTone> = {
    current: 'success',
    stale: 'warning',
    expired: 'danger',
  };
  return (
    <StatusBadge tone={tone[freshness]} data-freshness={freshness}>
      {t(`knowledge.freshness.${freshness}`)}
    </StatusBadge>
  );
}

export function VisibilityBadge({ visibility }: { visibility: KnowledgeSource['visibility'] }) {
  const { t } = useTranslation();
  const Icon = visibility === 'public' ? GlobeIcon : LockIcon;
  return (
    <StatusBadge
      tone={visibility === 'public' ? 'info' : 'neutral'}
      icon={<Icon className="size-3.5" aria-hidden="true" />}
    >
      {t(`knowledge.visibility.${visibility}`)}
    </StatusBadge>
  );
}

export function SourceStatusBadge({ status }: { status: KnowledgeSource['status'] }) {
  const { t } = useTranslation();
  const tone: Record<typeof status, StatusTone> = {
    active: 'success',
    paused: 'warning',
    retired: 'neutral',
  };
  return <StatusBadge tone={tone[status]}>{t(`knowledge.sourceStatus.${status}`)}</StatusBadge>;
}

type Outcome = NonNullable<Run['outcome']> | 'running';

const outcomeTone: Record<Outcome, StatusTone> = {
  replied: 'success',
  drafted: 'info',
  handoff: 'warning',
  fenced: 'neutral',
  blocked: 'danger',
  error: 'danger',
  skipped: 'neutral',
  running: 'info',
};

export const outcomeOf = (run: Run): Outcome => run.outcome ?? 'running';

export function OutcomeBadge({ run }: { run: Run }) {
  const { t } = useTranslation();
  const outcome = outcomeOf(run);
  return (
    <StatusBadge
      tone={outcomeTone[outcome]}
      data-outcome={outcome}
      {...(outcome === 'running'
        ? { icon: <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" /> }
        : {})}
    >
      {t(`runs.outcome.${outcome}`)}
    </StatusBadge>
  );
}

export function StepStatusBadge({ status }: { status: RunStep['status'] }) {
  const { t } = useTranslation();
  const tone: Record<typeof status, StatusTone> = {
    ok: 'success',
    error: 'danger',
    blocked: 'warning',
    skipped: 'neutral',
  };
  return <StatusBadge tone={tone[status]}>{t(`runs.detail.stepStatus.${status}`)}</StatusBadge>;
}
