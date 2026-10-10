import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, CircleDashedIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Section } from '../../components/PageHeader';
import { useInvitations } from '../../lib/access';
import { type AgentFact, canSetUp, setupSteps } from '../../lib/home';
import {
  useAgentDetails,
  useAgents,
  useAuthorityConnections,
  useBrandInstalls,
  useBrands,
  useMembers,
  useModelConnections,
} from '../../lib/queries';
import { hasServerKey, useModelStatus } from '../../lib/setup';
import { useTenant } from '../../lib/tenant';

function Checklist() {
  const { t } = useTranslation();
  const { can, me } = useTenant();
  const connections = useAuthorityConnections();
  const brands = useBrands();
  const installs = useBrandInstalls();
  const agents = useAgents();
  const members = useMembers();
  const invitations = useInvitations();
  const modelConnections = useModelConnections();
  const modelStatus = useModelStatus();
  // Which model a published agent answers with is in its details, not in the list.
  const published = (agents.data?.items ?? []).filter(
    (agent) => agent.status === 'active' && agent.publishedVersion !== null,
  );
  const details = useAgentDetails(can('agents.publish') ? published.map((agent) => agent.id) : []);
  // Nothing is said until the lists are in, so a finished workspace never flashes a checklist.
  if (
    [
      connections,
      brands,
      installs,
      agents,
      members,
      invitations,
      modelConnections,
      modelStatus,
      ...details,
    ].some((query) => query.isLoading)
  ) {
    return null;
  }
  const facts: AgentFact[] | undefined = agents.data?.items.map((agent) => {
    const index = published.findIndex((p) => p.id === agent.id);
    const provider =
      index >= 0 ? details[index]?.data?.published?.config.model.provider : undefined;
    return {
      status: agent.status,
      publishedVersion: agent.publishedVersion,
      ...(provider ? { usesMock: provider === 'mock' } : {}),
    };
  });
  const open = setupSteps(
    {
      connections: connections.data?.items,
      brands: brands.data?.items,
      installs: installs.data?.items,
      agents: facts,
      members: members.data?.items,
      invitations: invitations.data?.items,
      selfId: me.current?.staffMemberId,
      models: {
        connections: modelConnections.data?.items,
        serverKey: hasServerKey(modelStatus.data),
      },
    },
    can,
  ).filter((step) => !step.done);
  if (open.length === 0) return null;
  return (
    <Section
      id="overview-setup"
      title={t('overview.setup.title')}
      description={t('overview.setup.description')}
      actions={
        can('brands.manage') ? (
          <Button asChild variant="secondary" size="sm">
            <Link to="/onboarding" data-testid="guided-setup">
              {t('setup.home.guided')}
            </Link>
          </Button>
        ) : null
      }
    >
      <ul className="flex flex-col gap-2" data-testid="setup-steps">
        {open.map((step) => (
          <li key={step.id}>
            <Link
              to={step.to}
              {...(step.search ? { search: step.search } : {})}
              data-step={step.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-surface-sunken"
            >
              <CircleDashedIcon className="size-5 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-text">
                  {t(`setup.home.steps.${step.id}.title`)}
                </span>
                <span className="text-sm text-text-secondary">
                  {t(`setup.home.steps.${step.id}.description`)}
                </span>
              </span>
              <ArrowRightIcon
                className="size-4 shrink-0 text-text-muted rtl:-scale-x-100"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Home for people who run the workspace: what is left to set up, each step linking to its page,
 * and a way into the guided setup. Only unfinished steps show, and nothing shows once none is
 * left. A step is shown only when the person can do it and the lists they can read say whether it
 * is done (lib/home.ts). Someone who can do none of the steps does not even load the lists.
 */
export function GetSetUp() {
  const { can } = useTenant();
  return canSetUp(can) ? <Checklist /> : null;
}
