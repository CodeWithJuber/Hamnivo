import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { ArrowRightIcon, ExternalLinkIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandPicker, useChosenBrand } from '../../components/BrandPicker';
import { Section } from '../../components/PageHeader';
import { useBuiltinTools, useTools } from '../../lib/actions';
import {
  needsWork,
  type ReadinessAgent,
  type ReadinessConnector,
  type ReadinessState,
  type ReadinessStep,
  readinessSteps,
} from '../../lib/assistant-readiness';
import { DOCS } from '../../lib/docs';
import { canSetUp } from '../../lib/home';
import { useIdentityKeys } from '../../lib/identity';
import { useAgentDetails, useAgents, useModelConnections, useStudioQuery } from '../../lib/queries';
import { hasServerKey, useModelStatus } from '../../lib/setup';
import { useTenant } from '../../lib/tenant';

const TONE: Record<ReadinessState, StatusTone> = {
  done: 'success',
  todo: 'info',
  attention: 'warning',
  unknown: 'neutral',
  check: 'neutral',
};

/** Where each step is done. Agent steps open the brand's agent when it has one. */
function StepAction({ step, agentId }: { step: ReadinessStep; agentId: string | undefined }) {
  const { t } = useTranslation();
  const label = t(`setup.readiness.steps.${step.id}.action`);
  const variant = step.state === 'done' ? 'ghost' : 'secondary';
  const icon = <ArrowRightIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />;
  const testId = `readiness-${step.id}-action`;
  switch (step.id) {
    case 'website':
      return (
        <Button asChild variant={variant} size="sm">
          <a
            href={`${DOCS.integration('whmcs')}#signed-in-clients-optional`}
            target="_blank"
            rel="noreferrer"
            data-testid={testId}
          >
            {label}
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
          </a>
        </Button>
      );
    case 'aikey':
      return (
        <Button asChild variant={variant} size="sm">
          <Link to="/models" data-testid={testId}>
            {label}
            {icon}
          </Link>
        </Button>
      );
    case 'signin':
      return (
        <Button asChild variant={variant} size="sm">
          <Link to="/customer-identity" data-testid={testId}>
            {label}
            {icon}
          </Link>
        </Button>
      );
    case 'whmcs':
      return (
        <Button asChild variant={variant} size="sm">
          <Link to="/connectors" data-testid={testId}>
            {label}
            {icon}
          </Link>
        </Button>
      );
    default:
      return (
        <Button asChild variant={variant} size="sm">
          {agentId ? (
            <Link to="/agents/$agentId" params={{ agentId }} data-testid={testId}>
              {label}
              {icon}
            </Link>
          ) : (
            <Link to="/agents" data-testid={testId}>
              {label}
              {icon}
            </Link>
          )}
        </Button>
      );
  }
}

/** The words for why a step is not done, where the step has more than one way to fail. */
function reasonOf(t: TFunction, step: ReadinessStep): string | null {
  switch (step.id) {
    case 'aikey':
      return step.reason ? t(`setup.readiness.steps.aikey.reasons.${step.reason}`) : null;
    case 'model':
      return step.reason ? t(`setup.readiness.steps.model.reasons.${step.reason}`) : null;
    case 'whmcs':
      return step.reason ? t(`setup.readiness.steps.whmcs.reasons.${step.reason}`) : null;
    case 'actions':
      return step.reason ? t(`setup.readiness.steps.actions.reasons.${step.reason}`) : null;
    default:
      return null;
  }
}

function Checklist() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { brands, active, chosen } = useChosenBrand(undefined);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const brand = active.find((b) => b.id === picked) ?? chosen;
  const brandId = brand?.id;

  const agents = useAgents();
  const own = (agents.data?.items ?? []).filter(
    (agent) => agent.brandId === brandId && agent.status === 'active',
  );
  const agent = own.find((a) => a.isDefault) ?? own[0];
  const [detail] = useAgentDetails(agent && can('agents.read') ? [agent.id] : []);
  const modelConnections = useModelConnections();
  const modelStatus = useModelStatus();
  const identityKeys = useIdentityKeys(brandId);
  // The same list (and cache entry) as the Connectors page.
  const connectors = useStudioQuery<{ items: ReadinessConnector[] }>(
    ['connectors', brandId ?? ''],
    `/v1/admin/connectors?brandId=${encodeURIComponent(brandId ?? '')}`,
    { enabled: can('tools.read') && !!brandId },
  );
  const tools = useTools(brandId);
  const builtins = useBuiltinTools();

  // Nothing is said until the lists are in, so a working assistant never flashes a checklist.
  if (
    !brandId ||
    [agents, modelConnections, modelStatus, identityKeys, connectors, tools, builtins, detail].some(
      (query) => query?.isLoading,
    )
  ) {
    return null;
  }
  const version = detail?.data ? (detail.data.published ?? detail.data.draft) : undefined;
  let readinessAgent: ReadinessAgent | null | undefined;
  if (!agents.data) readinessAgent = undefined;
  else if (!agent) readinessAgent = null;
  else
    readinessAgent = {
      id: agent.id,
      published: agent.publishedVersion !== null,
      provider: version?.config.model.provider,
      grants: version ? version.config.tools.grants.map((grant) => grant.toolId) : undefined,
    };
  const steps = readinessSteps({
    serverKey: hasServerKey(modelStatus.data),
    modelConnections: modelConnections.data?.items,
    modelTests: modelStatus.data?.tests,
    agent: readinessAgent,
    identityKeys: identityKeys.data?.items,
    connectors: connectors.data?.items,
    tools: tools.data?.items,
    builtins: builtins.data?.items,
  });
  if (!needsWork(steps)) return null;
  const firstOpen = steps.find((step) => step.state === 'todo' || step.state === 'attention');

  return (
    <Section
      id="assistant-readiness"
      title={t('setup.readiness.title')}
      description={t('setup.readiness.description')}
      actions={
        <BrandPicker
          id="readiness-brand"
          label={t('setup.readiness.brand')}
          brands={brands.items ?? []}
          value={brandId}
          onChange={setPicked}
        />
      }
    >
      <ol className="flex flex-col gap-2" data-testid="readiness-steps">
        {steps.map((step, index) => {
          const open = step.state === 'todo' || step.state === 'attention';
          const reason = reasonOf(t, step);
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-state={step.state}
              aria-current={step === firstOpen ? 'step' : undefined}
              className={`flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-3 ${
                step === firstOpen ? 'border-ring bg-surface-sunken' : 'border-border'
              }`}
            >
              <span className="flex min-w-0 flex-1 items-start gap-3">
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-sm font-semibold"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text">
                      {t(`setup.readiness.steps.${step.id}.title`)}
                    </span>
                    <StatusBadge tone={TONE[step.state]}>
                      {t(`setup.readiness.states.${step.state}`)}
                    </StatusBadge>
                  </span>
                  {open || step.state === 'check' || step.state === 'unknown' ? (
                    <span className="text-sm text-text-secondary">
                      {step.state === 'unknown'
                        ? t('setup.readiness.unknown')
                        : (reason ?? t(`setup.readiness.steps.${step.id}.description`))}
                    </span>
                  ) : null}
                </span>
              </span>
              {step.state === 'unknown' ? null : (
                <span className="flex shrink-0 ps-10 sm:ps-0">
                  <StepAction step={step} agentId={agent?.id} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/**
 * Home's "Make the AI assistant work" checklist: what a brand still needs before its AI can act on
 * a customer's WHMCS account, in order, each step with what is wrong and one button to the page
 * that fixes it. It shows while any step is not set up or not working, for people who set up.
 */
export function AssistantReadiness() {
  const { can } = useTenant();
  return canSetUp(can) ? <Checklist /> : null;
}
