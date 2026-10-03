import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { Link } from '@tanstack/react-router';
import { PlusIcon, UsersIcon, XIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { SelectField, TextField } from '../../components/Fields';
import { PageHeader } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { accessKeys, useTeams } from '../../lib/access';
import { api, newIdempotencyKey } from '../../lib/api';
import { useMembers, useStudioMutation, useWorkspaces } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { Member, Team } from '../../lib/types';

/** The people who can still be added to a team: active staff who are not in it already. */
export function addable(members: readonly Member[], team: Pick<Team, 'members'>): Member[] {
  const inTeam = new Set(team.members.map((m) => m.staffMemberId));
  return members.filter((member) => member.status === 'active' && !inTeam.has(member.id));
}

function CreateTeamDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const workspaces = useWorkspaces();
  const [name, setName] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const areas = workspaces.data?.items.filter((w) => w.status === 'active') ?? [];
  const chosen = workspaceId || areas[0]?.id || '';

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(undefined);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const create = useStudioMutation(
    (body: { name: string; workspaceId: string | null }, tenant) =>
      api<Team>('/v1/admin/teams', { method: 'POST', body, tenant, idempotencyKey }),
    [accessKeys.teams],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t('setup.teams.nameRequired'));
      return;
    }
    setError(undefined);
    try {
      const team = await create.mutateAsync({ name: name.trim(), workspaceId: chosen || null });
      announce(t('setup.teams.created', { name: team.name }));
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title={t('setup.teams.createTitle')}
      description={t('setup.teams.createDescription')}
      testId="create-team-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary
          title={t('auth.errorSummary')}
          errors={error ? [{ fieldId: 'team-name', message: error }] : []}
        />
        <TextField
          id="team-name"
          label={t('setup.teams.name')}
          hint={t('setup.teams.nameHint')}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          error={error}
        />
        {areas.length > 1 ? (
          <SelectField
            id="team-area"
            label={t('brands.area')}
            value={chosen}
            onChange={(event) => setWorkspaceId(event.target.value)}
            options={areas.map((w) => ({ value: w.id, label: w.name }))}
          />
        ) : null}
        <ActionError error={isCancelled(create.error) ? null : create.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={create.isPending}>
            {t('setup.teams.create')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function TeamCard({
  team,
  members,
  editable,
}: {
  team: Team;
  members: readonly Member[];
  editable: boolean;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [pick, setPick] = useState('');
  const options = addable(members, team);
  const set = useStudioMutation(
    (staffMemberIds: string[], tenant) =>
      api<Team>(`/v1/admin/teams/${team.id}/members`, {
        method: 'PUT',
        tenant,
        body: { staffMemberIds },
      }),
    [accessKeys.teams, accessKeys.members],
  );
  const ids = team.members.map((m) => m.staffMemberId);
  const change = async (next: string[], said: string) => {
    try {
      await set.mutateAsync(next);
      announce(said);
    } catch {
      // Shown in the card.
    }
  };
  const open = editable && team.status === 'active';

  return (
    <section
      aria-labelledby={`team-${team.id}-title`}
      data-testid="team-card"
      data-team={team.name}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`team-${team.id}-title`} className="text-lg font-semibold text-text">
          <bdi>{team.name}</bdi>
        </h2>
        {team.status === 'archived' ? (
          <StatusBadge tone="neutral">{t('setup.teams.archived')}</StatusBadge>
        ) : (
          <span className="text-sm text-text-secondary">
            {t('setup.teams.count', { n: team.members.length })}
          </span>
        )}
      </div>
      {team.members.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('setup.teams.noMembers')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="team-members">
          {team.members.map((member) => (
            <li
              key={member.staffMemberId}
              className="inline-flex items-center gap-1 rounded-full bg-surface-sunken py-1 ps-3 pe-1 text-sm"
            >
              <bdi>{member.displayName}</bdi>
              {open ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  disabled={set.isPending}
                  aria-label={t('setup.teams.remove', {
                    name: member.displayName,
                    team: team.name,
                  })}
                  onClick={() =>
                    change(
                      ids.filter((id) => id !== member.staffMemberId),
                      t('setup.teams.removed', { name: member.displayName, team: team.name }),
                    )
                  }
                >
                  <XIcon aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const person = options.find((m) => m.id === pick);
            if (!person) return;
            await change(
              [...ids, person.id],
              t('setup.teams.added', { name: person.displayName, team: team.name }),
            );
            setPick('');
          }}
        >
          <div className="min-w-56 flex-1">
            <SelectField
              id={`team-${team.id}-add`}
              label={t('setup.teams.addLabel')}
              value={pick}
              placeholder={options.length > 0 ? t('setup.teams.choose') : t('setup.teams.everyone')}
              disabled={options.length === 0}
              onChange={(event) => setPick(event.target.value)}
              options={options.map((m) => ({ value: m.id, label: m.displayName }))}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={!pick} busy={set.isPending}>
            <PlusIcon aria-hidden="true" />
            {t('setup.teams.add')}
          </Button>
        </form>
      ) : null}
      <ActionError error={isCancelled(set.error) ? null : set.error} />
    </section>
  );
}

/**
 * Support teams: who is in each team. People are added and taken out here, one at a time; each
 * change replaces the team's list at the gateway (`PUT /v1/admin/teams/:id/members`). Teams are
 * what routing hands chats to; where they are used is set under the brand's rules.
 */
export function TeamsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const teams = useTeams();
  const members = useMembers();
  const [creating, setCreating] = useState(false);
  const editable = can('teams.manage');

  const create = (
    <ReasonedAction reason={editable ? null : t('setup.teams.noPermission')}>
      <Button onClick={() => setCreating(true)} data-testid="create-team">
        <PlusIcon aria-hidden="true" />
        {t('setup.teams.create')}
      </Button>
    </ReasonedAction>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('setup.teams.title')}
        description={t('setup.teams.description')}
        actions={create}
      />
      <QueryState
        query={teams}
        label={t('setup.teams.loading')}
        permitted={can('members.read')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('setup.teams.empty.title')}
            description={t('setup.teams.empty.description')}
            icon={<UsersIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={create}
          />
        }
      >
        {(data) => (
          <div className="flex flex-col gap-6">
            {data.items.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                members={members.data?.items ?? []}
                editable={editable}
              />
            ))}
            <p className="text-sm text-text-secondary">
              {t('setup.teams.rules')}{' '}
              <Link
                to="/decisions"
                className="text-link underline underline-offset-4 hover:no-underline"
              >
                {t('setup.teams.rulesLink')}
              </Link>
            </p>
          </div>
        )}
      </QueryState>
      <CreateTeamDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
