import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, CircleDashedIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Section } from '../../components/PageHeader';
import { useInvitations } from '../../lib/access';
import { canSetUp, setupSteps } from '../../lib/home';
import { useAgents, useAuthorityConnections, useBrands, useMembers } from '../../lib/queries';
import { useTenant } from '../../lib/tenant';

function Checklist() {
  const { t } = useTranslation();
  const { can, me } = useTenant();
  const connections = useAuthorityConnections();
  const brands = useBrands();
  const agents = useAgents();
  const members = useMembers();
  const invitations = useInvitations();
  // Nothing is said until the lists are in, so a finished workspace never flashes a checklist.
  if ([connections, brands, agents, members, invitations].some((query) => query.isLoading)) {
    return null;
  }
  const open = setupSteps(
    {
      connections: connections.data?.items,
      brands: brands.data?.items,
      agents: agents.data?.items,
      members: members.data?.items,
      invitations: invitations.data?.items,
      selfId: me.current?.staffMemberId,
    },
    can,
  ).filter((step) => !step.done);
  if (open.length === 0) return null;
  return (
    <Section
      id="overview-setup"
      title={t('overview.setup.title')}
      description={t('overview.setup.description')}
    >
      <ul className="flex flex-col gap-2" data-testid="setup-steps">
        {open.map((step) => (
          <li key={step.id}>
            <Link
              to={step.to}
              data-step={step.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-surface-sunken"
            >
              <CircleDashedIcon className="size-5 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-text">
                  {t(`overview.setup.steps.${step.id}.title`)}
                </span>
                <span className="text-sm text-text-secondary">
                  {t(`overview.setup.steps.${step.id}.description`)}
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
 * Home for people who run the workspace: what is left to set up, each step linking to its page.
 * Only unfinished steps show, and nothing shows once none is left. A step is shown only when the
 * person can do it and the lists they can read say whether it is done (lib/home.ts). Someone who
 * can do none of the steps does not even load the lists.
 */
export function GetSetUp() {
  const { can } = useTenant();
  return canSetUp(can) ? <Checklist /> : null;
}
