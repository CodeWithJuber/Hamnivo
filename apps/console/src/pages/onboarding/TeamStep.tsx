import { Button } from '@hamnivo/ui/components/button';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { UserPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInvitations } from '../../lib/access';
import { useMembers } from '../../lib/queries';
import { useTenant } from '../../lib/tenant';
import { InviteDialog } from '../team/InviteDialog';

/**
 * Step 7: bring in the people who will answer chats. It opens the same invitation form as the
 * team page; the step counts who has been invited and finishes the guide.
 */
export function TeamStep({ onDone }: { onDone: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const { can, me } = useTenant();
  const members = useMembers();
  const invitations = useInvitations();
  const [inviting, setInviting] = useState(false);
  const others = (members.data?.items ?? []).filter(
    (member) => member.id !== me.current?.staffMemberId,
  ).length;
  const invited = (invitations.data?.items ?? []).filter(
    (invitation) => invitation.status === 'pending' || invitation.status === 'accepted',
  ).length;

  return (
    <div className="flex flex-col gap-5" data-testid="onboarding-team">
      <p className="text-sm text-text" data-testid="team-count">
        {others + invited === 0
          ? t('setup.onboarding.team.none')
          : t('setup.onboarding.team.some', { people: others, invited })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <ReasonedAction
          reason={can('members.invite') ? null : t('setup.onboarding.team.noPermission')}
        >
          <Button type="button" variant="secondary" onClick={() => setInviting(true)}>
            <UserPlusIcon aria-hidden="true" />
            {t('setup.onboarding.team.invite')}
          </Button>
        </ReasonedAction>
        <Button type="button" onClick={() => void onDone()}>
          {t('setup.onboarding.team.finish')}
        </Button>
      </div>
      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </div>
  );
}
