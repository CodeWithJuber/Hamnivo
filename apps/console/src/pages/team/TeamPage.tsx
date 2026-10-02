import { Button } from '@hamnivo/ui/components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@hamnivo/ui/components/tabs';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { UserPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden } from '../../components/States';
import { useTenant } from '../../lib/tenant';
import type { TeamTab } from '../../routes/_studio/team';
import { AuditTab } from './AuditTab';
import { InviteDialog } from './InviteDialog';
import { MembersTab } from './MembersTab';
import { RolesTab } from './RolesTab';

const TAB = 'min-h-10 px-3 text-text-secondary hover:text-text data-[state=active]:text-text';

/** Team and access (board 22): members, roles and the audit log, all within the caller's reach. */
export function TeamPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/team' });
  const navigate = useNavigate({ from: '/team' });
  const [inviting, setInviting] = useState(false);
  const tab: TeamTab =
    search.tab === 'audit' && !can('audit.read') ? 'members' : (search.tab ?? 'members');

  if (!can('members.read')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('access.team.title')} />
        <Forbidden />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<p className="text-sm text-text-secondary">{t('access.settings')}</p>}
        title={t('access.team.title')}
        description={t('access.team.description')}
        actions={
          can('members.invite') ? (
            <Button onClick={() => setInviting(true)} data-testid="invite-teammate">
              <UserPlusIcon aria-hidden="true" />
              {t('access.team.invite')}
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            search: (prev) => ({
              ...prev,
              tab: value === 'members' ? undefined : (value as TeamTab),
              role: undefined,
            }),
          })
        }
      >
        <TabsList variant="line" className="h-auto flex-wrap justify-start">
          <TabsTrigger value="members" className={TAB}>
            {t('access.team.tabs.members')}
          </TabsTrigger>
          <TabsTrigger value="roles" className={TAB}>
            {t('access.team.tabs.roles')}
          </TabsTrigger>
          {can('audit.read') ? (
            <TabsTrigger value="audit" className={TAB}>
              {t('access.team.tabs.audit')}
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="members" className="pt-4">
          <MembersTab />
        </TabsContent>
        <TabsContent value="roles" className="pt-4">
          <RolesTab />
        </TabsContent>
        {can('audit.read') ? (
          <TabsContent value="audit" className="pt-4">
            <AuditTab />
          </TabsContent>
        ) : null}
      </Tabs>
      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </div>
  );
}
