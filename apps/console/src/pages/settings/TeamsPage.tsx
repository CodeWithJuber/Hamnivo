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
import { CheckboxField, ChoiceField, SelectField, TextField } from '../../components/Fields';
import { PageHeader, Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { accessKeys, useTeams } from '../../lib/access';
import { api, newIdempotencyKey } from '../../lib/api';
import {
  LANGUAGE_SLICES,
  type LanguageSlice,
  parseLimit,
  parseTimeout,
  type RoutingProfile,
  type TeamAssignmentMode,
  useRoutingProfiles,
  useSaveRoutingProfile,
  useUpdateTeam,
} from '../../lib/offers';
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

/**
 * How a chat handed to the team reaches its people (HNV-10-03): everyone sees it in the queue, or
 * it is offered to one person at a time for a number of seconds each.
 */
function TeamOffersDialog({
  team,
  open,
  onOpenChange,
}: {
  team: Team;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const update = useUpdateTeam(team.id);
  const [mode, setMode] = useState<TeamAssignmentMode>('queue');
  const [seconds, setSeconds] = useState('');
  const [error, setError] = useState<string | undefined>();
  const id = `team-${team.id}`;

  // Each opening starts from how the team works now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setMode(team.assignmentMode);
    setSeconds(String(team.offerTimeoutSeconds));
    setError(undefined);
    update.reset();
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Null in queue mode: the team keeps its seconds for when offers are turned on again.
    const timeout = mode === 'offer' ? parseTimeout(seconds) : null;
    if (timeout === undefined) {
      setError(t('inbox.offers.team.timeoutInvalid'));
      return;
    }
    setError(undefined);
    try {
      await update.mutateAsync(
        timeout === null
          ? { assignmentMode: 'queue' }
          : { assignmentMode: 'offer', offerTimeoutSeconds: timeout },
      );
      announce(t('inbox.offers.team.saved', { team: team.name }));
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!update.isPending) onOpenChange(next);
      }}
      title={t('inbox.offers.team.title', { team: team.name })}
      description={t('inbox.offers.team.description')}
      testId="team-offers-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary
          title={t('auth.errorSummary')}
          errors={error ? [{ fieldId: `${id}-timeout`, message: error }] : []}
        />
        <ChoiceField
          id={`${id}-mode`}
          legend={t('inbox.offers.team.mode')}
          value={mode}
          onValueChange={(value) => {
            setMode(value as TeamAssignmentMode);
            setError(undefined);
          }}
          choices={[
            {
              value: 'queue',
              label: t('inbox.offers.team.modes.queue'),
              hint: t('inbox.offers.team.modes.queueHint'),
            },
            {
              value: 'offer',
              label: t('inbox.offers.team.modes.offer'),
              hint: t('inbox.offers.team.modes.offerHint'),
            },
          ]}
        />
        {mode === 'offer' ? (
          <TextField
            id={`${id}-timeout`}
            label={t('inbox.offers.team.timeout')}
            hint={t('inbox.offers.team.timeoutHint')}
            inputMode="numeric"
            value={seconds}
            maxLength={3}
            onChange={(event) => setSeconds(event.target.value)}
            error={error}
          />
        ) : null}
        <ActionError error={isCancelled(update.error) ? null : update.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={update.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={update.isPending}>
            {t('inbox.offers.team.save')}
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
  const [arranging, setArranging] = useState(false);
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary" data-testid="team-arrival">
          {team.assignmentMode === 'offer'
            ? t('inbox.offers.team.summaryOffer', { seconds: team.offerTimeoutSeconds })
            : t('inbox.offers.team.summaryQueue')}
        </p>
        {open ? (
          <Button
            type="button"
            variant="secondary"
            aria-label={t('inbox.offers.team.editName', { team: team.name })}
            onClick={() => setArranging(true)}
          >
            {t('inbox.offers.team.edit')}
          </Button>
        ) : null}
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
      {open ? <TeamOffersDialog team={team} open={arranging} onOpenChange={setArranging} /> : null}
    </section>
  );
}

/** One person's languages and open-chat limit, which decide which offered chats reach them. */
function RoutingProfileDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: RoutingProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const save = useSaveRoutingProfile();
  const [languages, setLanguages] = useState<LanguageSlice[]>([]);
  const [max, setMax] = useState('');
  const [error, setError] = useState<string | undefined>();
  const id = `routing-${profile.staffMemberId}`;

  // Each opening starts from what is saved for them now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setLanguages(profile.languages);
    setMax(profile.maxOpenChats === null ? '' : String(profile.maxOpenChats));
    setError(undefined);
    save.reset();
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const limit = parseLimit(max);
    if (limit === undefined) {
      setError(t('inbox.offers.people.maxInvalid'));
      return;
    }
    setError(undefined);
    try {
      await save.mutateAsync({
        staffMemberId: profile.staffMemberId,
        // In the order Studio lists them, whatever order they were ticked in.
        languages: LANGUAGE_SLICES.filter((slice) => languages.includes(slice)),
        maxOpenChats: limit,
      });
      announce(t('inbox.offers.people.saved', { name: profile.displayName }));
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
      title={t('inbox.offers.people.dialogTitle', { name: profile.displayName })}
      testId="routing-profile-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary
          title={t('auth.errorSummary')}
          errors={error ? [{ fieldId: `${id}-max`, message: error }] : []}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-text">
            {t('inbox.offers.people.languages')}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {LANGUAGE_SLICES.map((slice) => (
              <CheckboxField
                key={slice}
                id={`${id}-${slice}`}
                label={t(`decisions.slices.${slice}`)}
                checked={languages.includes(slice)}
                onCheckedChange={(checked) =>
                  setLanguages((now) =>
                    checked ? [...now, slice] : now.filter((s) => s !== slice),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
        <TextField
          id={`${id}-max`}
          label={t('inbox.offers.people.max')}
          hint={t('inbox.offers.people.maxHint')}
          inputMode="numeric"
          value={max}
          maxLength={2}
          onChange={(event) => setMax(event.target.value)}
          error={error}
        />
        <ActionError error={isCancelled(save.error) ? null : save.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending}>
            {t('inbox.offers.people.save')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function RoutingProfileRow({ profile, editable }: { profile: RoutingProfile; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const languages =
    profile.languages.length > 0
      ? new Intl.ListFormat(i18n.resolvedLanguage ?? i18n.language, { type: 'unit' }).format(
          profile.languages.map((slice) => t(`decisions.slices.${slice}`)),
        )
      : t('inbox.offers.people.none');

  return (
    <li
      data-testid="routing-profile"
      data-staff={profile.staffMemberId}
      className="flex flex-wrap items-center gap-x-6 gap-y-3 py-3"
    >
      <div className="flex min-w-40 flex-1 flex-col gap-1">
        <span className="font-medium text-text">
          <bdi>{profile.displayName}</bdi>
        </span>
        <span className="text-sm text-text-secondary">{languages}</span>
        <span className="text-sm text-text-secondary">
          {profile.maxOpenChats === null
            ? t('inbox.offers.people.noLimit')
            : t('inbox.offers.people.limit', { max: profile.maxOpenChats })}
        </span>
      </div>
      {editable ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label={t('inbox.offers.people.editName', { name: profile.displayName })}
            onClick={() => setEditing(true)}
          >
            {t('inbox.offers.people.edit')}
          </Button>
          <RoutingProfileDialog profile={profile} open={editing} onOpenChange={setEditing} />
        </>
      ) : null}
    </li>
  );
}

/**
 * Everyone's languages and open-chat limit, for teams that offer chats one person at a time. Its
 * own load: when it fails, the teams above are still shown and only this part offers a retry.
 */
function RoutingProfiles({ editable }: { editable: boolean }) {
  const { t } = useTranslation();
  const profiles = useRoutingProfiles();
  return (
    <Section
      id="routing-profiles"
      title={t('inbox.offers.people.title')}
      description={t('inbox.offers.people.description')}
    >
      <QueryState query={profiles} label={t('inbox.offers.people.loading')}>
        {(data) => (
          <ul className="flex flex-col divide-y divide-border" data-testid="routing-profiles">
            {data.items.map((profile) => (
              <RoutingProfileRow
                key={profile.staffMemberId}
                profile={profile}
                editable={editable}
              />
            ))}
          </ul>
        )}
      </QueryState>
    </Section>
  );
}

/**
 * Support teams: who is in each team. People are added and taken out here, one at a time; each
 * change replaces the team's list at the gateway (`PUT /v1/admin/teams/:id/members`). Teams are
 * what routing hands chats to; where they are used is set under the brand's rules. Each team
 * also says how its chats arrive (a queue, or offered to one person at a time), and below the
 * teams everyone's languages and open-chat limit decide who is offered what.
 */
export function TeamsPage() {
  const { t } = useTranslation();
  const { can, features } = useTenant();
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
            {/* Decision rules are frozen unless the server lists advanced features. */}
            {features.advanced ? (
              <p className="text-sm text-text-secondary">
                {t('setup.teams.rules')}{' '}
                <Link
                  to="/decisions"
                  className="text-link underline underline-offset-4 hover:no-underline"
                >
                  {t('setup.teams.rulesLink')}
                </Link>
              </p>
            ) : null}
            <RoutingProfiles editable={editable} />
          </div>
        )}
      </QueryState>
      <CreateTeamDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
