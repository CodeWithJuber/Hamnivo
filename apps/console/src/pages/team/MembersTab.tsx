import { Button } from '@hamnivo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@hamnivo/ui/components/dropdown-menu';
import { Input } from '@hamnivo/ui/components/input';
import { Label } from '@hamnivo/ui/components/label';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CircleCheckIcon, CrownIcon, MoreHorizontalIcon, SearchIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { ActionError, QueryState } from '../../components/States';
import { accessKeys, useAuditLog, useInvitations } from '../../lib/access';
import {
  auditActionLabel,
  type ScopeNames,
  scopeLabel,
  useScopeNames,
} from '../../lib/access-text';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useMembers, useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { CreatedInvitation, Invitation, Member } from '../../lib/types';
import { AccessDialog } from './AccessDialog';
import { OffboardDialog } from './OffboardDialog';

type Pending =
  | { kind: 'suspend' | 'restore'; member: Member }
  | { kind: 'revoke-invite'; invitation: Invitation };

const STATUS_TONE: Record<string, StatusTone> = {
  active: 'success',
  suspended: 'warning',
  invited: 'info',
  expired: 'neutral',
  removed: 'neutral',
};

function Initial({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-sm font-semibold text-text"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

function RoleCell({ member, names }: { member: Member; names: ScopeNames }) {
  const { t } = useTranslation();
  if (member.grants.length === 0) {
    return <span className="text-text-secondary">{t('access.team.noRole')}</span>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {member.grants.map((grant) => (
        <li key={grant.id} className="flex flex-wrap items-center gap-1">
          <StatusBadge
            tone={grant.role.key === 'owner' ? 'brand' : 'neutral'}
            icon={
              grant.role.key === 'owner' ? (
                <CrownIcon className="size-3.5" aria-hidden="true" />
              ) : null
            }
          >
            <bdi>{grant.role.name}</bdi>
          </StatusBadge>
          {grant.scope.type === 'tenant' ? null : (
            <span className="text-xs text-text-secondary">{scopeLabel(t, grant.scope, names)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function MemberActions({
  member,
  self,
  onPick,
}: {
  member: Member;
  self: boolean;
  onPick: (action: 'access' | 'suspend' | 'restore' | 'remove') => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const canManageAccess = can('grants.manage');
  const canRemove = can('members.remove');
  if (!canManageAccess && !canRemove) return null;
  const blocked = self || !member.manageable;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('access.team.actionsFor', { name: member.displayName })}
          data-testid="member-actions"
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        {blocked ? (
          <>
            <DropdownMenuLabel className="font-normal whitespace-normal text-text-secondary">
              {self ? t('access.team.selfNote') : t('access.team.beyondReach')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {canManageAccess ? (
          <DropdownMenuItem disabled={blocked} onSelect={() => onPick('access')}>
            {t('access.team.changeAccess')}
          </DropdownMenuItem>
        ) : null}
        {canRemove ? (
          <>
            {member.status === 'suspended' ? (
              <DropdownMenuItem disabled={blocked} onSelect={() => onPick('restore')}>
                {t('access.team.restore')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={blocked} onSelect={() => onPick('suspend')}>
                {t('access.team.suspend')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={blocked}
              variant="destructive"
              onSelect={() => onPick('remove')}
            >
              {t('access.team.remove')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InvitationActions({
  invitation,
  onResend,
  onRevoke,
}: {
  invitation: Invitation;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  if (!can('members.invite')) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('access.team.actionsFor', { name: invitation.email })}
          data-testid="invitation-actions"
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onResend}>{t('access.team.resend')}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
          {t('access.team.revokeInvite')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Recent changes to people and roles, for context under the list (board 22). */
function RecentActivity() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const log = useAuditLog({}, 5);
  const members = useMembers();
  if (!can('audit.read') || log.isError) return null;
  const names = new Map((members.data?.items ?? []).map((m) => [m.id, m.displayName]));
  const items = log.data?.pages[0]?.items ?? [];
  return (
    <section aria-labelledby="recent-activity-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="recent-activity-title" className="text-lg font-semibold text-text">
          {t('access.team.recent')}
        </h2>
        <Link
          to="/team"
          search={{ tab: 'audit' }}
          className="text-sm text-link underline underline-offset-4 hover:no-underline"
        >
          {t('access.team.viewAudit')}
        </Link>
      </div>
      {log.isPending ? (
        <p aria-busy="true" className="text-sm text-text-secondary">
          {t('access.team.recentLoading')}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('access.team.recentEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
          {items.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
              <span className="font-medium text-text">
                <bdi>
                  {event.actor.type === 'staff'
                    ? (names.get(event.actor.id ?? '') ?? event.actor.id)
                    : t(`access.audit.actorTypes.${event.actor.type as 'staff'}`)}
                </bdi>
              </span>
              <span className="text-text">{auditActionLabel(t, event.action)}</span>
              {event.target?.type === 'staff' && event.target.id ? (
                <bdi className="text-text-secondary">
                  {names.get(event.target.id) ?? event.target.id}
                </bdi>
              ) : null}
              <span className="ms-auto text-text-secondary">
                {formatDateTime(event.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Members and pending invitations, with what the caller may change for each (board 22). */
export function MembersTab() {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { me } = useTenant();
  const search = useSearch({ from: '/_studio/team' });
  const navigate = useNavigate({ from: '/team' });
  const members = useMembers();
  const invitations = useInvitations();
  const names = useScopeNames();
  const [query, setQuery] = useState(search.q ?? '');
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const invalidate = [accessKeys.members, accessKeys.invitations, accessKeys.audit];
  const setStatus = useStudioMutation(
    ({ id, status }: { id: string; status: 'active' | 'suspended' }, tenant) =>
      api<Member>(`/v1/admin/members/${id}`, { method: 'PATCH', body: { status }, tenant }),
    invalidate,
  );
  const resend = useStudioMutation(
    (id: string, tenant) =>
      api<CreatedInvitation>(`/v1/admin/invitations/${id}/resend`, { method: 'POST', tenant }),
    invalidate,
  );
  const revokeInvite = useStudioMutation(
    (id: string, tenant) => api<void>(`/v1/admin/invitations/${id}`, { method: 'DELETE', tenant }),
    invalidate,
  );

  const say = (message: string) => {
    setNotice(message);
    announce(message);
  };

  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const now = Date.now();
  const openInvitations = useMemo(
    () => (invitations.data?.items ?? []).filter((i) => i.status === 'pending'),
    [invitations.data],
  );
  const accessMember = members.data?.items.find((m) => m.id === accessFor) ?? null;

  return (
    <div className="flex flex-col gap-6">
      {notice ? (
        <p
          role="status"
          data-testid="members-notice"
          className="flex items-start gap-3 rounded-lg border border-success/40 bg-success-subtle p-3 text-sm text-text"
        >
          <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          <span className="flex-1">{notice}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('app.close')}
            onClick={() => setNotice(null)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:max-w-sm">
        <Label htmlFor="member-search">{t('access.team.search')}</Label>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <Input
            id="member-search"
            type="search"
            value={query}
            placeholder={t('access.team.searchPlaceholder')}
            className="ps-9"
            onChange={(event) => {
              setQuery(event.target.value);
              void navigate({
                search: (prev) => ({ ...prev, q: event.target.value || undefined }),
                replace: true,
              });
            }}
          />
        </div>
      </div>
      <QueryState query={members} label={t('access.team.loading')}>
        {(data) => {
          const shown = data.items.filter((m) => matches(`${m.displayName} ${m.email}`));
          const shownInvites = openInvitations.filter((i) => matches(i.email));
          const active = data.items.filter((m) => m.status === 'active').length;
          return (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">
                {t('access.team.activeCount', { n: active })}
              </p>
              {shown.length + shownInvites.length === 0 ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border p-4 text-sm">
                  <span>{t('access.team.noMatches', { query })}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setQuery('');
                      void navigate({ search: (prev) => ({ ...prev, q: undefined }) });
                    }}
                  >
                    {t('access.team.clearSearch')}
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
                  <Table data-testid="members-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-start">
                          {t('access.team.columns.name')}
                        </TableHead>
                        <TableHead className="text-start">
                          {t('access.team.columns.role')}
                        </TableHead>
                        <TableHead className="text-start">
                          {t('access.team.columns.teams')}
                        </TableHead>
                        <TableHead className="text-start">
                          {t('access.team.columns.lastActive')}
                        </TableHead>
                        <TableHead className="text-start">
                          {t('access.team.columns.status')}
                        </TableHead>
                        <TableHead className="text-start">
                          <span className="sr-only">{t('access.team.columns.actions')}</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((member) => {
                        const self = member.id === me.current?.staffMemberId;
                        return (
                          <TableRow key={member.id} data-member={member.email}>
                            <TableCell>
                              <span className="flex items-center gap-3">
                                <Initial name={member.displayName} />
                                <span className="flex min-w-0 flex-col">
                                  <span className="font-medium text-text">
                                    <bdi>{member.displayName}</bdi>
                                    {self ? (
                                      <span className="ms-2 text-xs font-normal text-text-secondary">
                                        ({t('access.you')})
                                      </span>
                                    ) : null}
                                  </span>
                                  <bdi dir="ltr" className="text-xs text-text-secondary">
                                    {member.email}
                                  </bdi>
                                </span>
                              </span>
                            </TableCell>
                            <TableCell>
                              <RoleCell member={member} names={names} />
                            </TableCell>
                            <TableCell className="whitespace-normal">
                              {member.teams.length > 0 ? (
                                <bdi>{member.teams.map((team) => team.name).join(', ')}</bdi>
                              ) : (
                                <span className="text-text-secondary">
                                  {t('access.team.noTeams')}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {member.lastActiveAt ? (
                                formatDateTime(member.lastActiveAt)
                              ) : (
                                <span className="text-text-secondary">
                                  {t('access.team.notYet')}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                tone={STATUS_TONE[member.status] ?? 'neutral'}
                                data-status={member.status}
                              >
                                {t(`access.team.status.${member.status}`)}
                              </StatusBadge>
                            </TableCell>
                            <TableCell>
                              <MemberActions
                                member={member}
                                self={self}
                                onPick={(action) => {
                                  setNotice(null);
                                  if (action === 'access') setAccessFor(member.id);
                                  else if (action === 'remove') setRemoving(member);
                                  else setPending({ kind: action, member });
                                }}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {shownInvites.map((invitation) => {
                        const expired = new Date(invitation.expiresAt).getTime() < now;
                        return (
                          <TableRow key={invitation.id} data-invitation={invitation.email}>
                            <TableCell>
                              <span className="flex items-center gap-3">
                                <Initial name={invitation.email} />
                                <bdi dir="ltr" className="font-medium text-text">
                                  {invitation.email}
                                </bdi>
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="flex flex-wrap items-center gap-1">
                                <StatusBadge tone="neutral" icon={null}>
                                  <bdi>{invitation.role.name}</bdi>
                                </StatusBadge>
                                {invitation.scope.type === 'tenant' ? null : (
                                  <span className="text-xs text-text-secondary">
                                    {scopeLabel(t, invitation.scope, names)}
                                  </span>
                                )}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-text-secondary">—</span>
                            </TableCell>
                            <TableCell>
                              {t('access.team.invitedOn', {
                                time: formatDateTime(invitation.createdAt),
                              })}
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                tone={expired ? 'neutral' : 'warning'}
                                data-status={expired ? 'expired' : 'invited'}
                              >
                                {expired
                                  ? t('access.team.status.expired')
                                  : t('access.team.status.invited')}
                              </StatusBadge>
                            </TableCell>
                            <TableCell>
                              <InvitationActions
                                invitation={invitation}
                                onResend={async () => {
                                  setNotice(null);
                                  try {
                                    const sent = await resend.mutateAsync(invitation.id);
                                    say(t('access.team.resent', { email: sent.email }));
                                  } catch {
                                    // Shown in the error line below the table.
                                  }
                                }}
                                onRevoke={() => setPending({ kind: 'revoke-invite', invitation })}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          );
        }}
      </QueryState>
      <ActionError error={isCancelled(resend.error) ? null : resend.error} />
      <RecentActivity />

      {accessMember ? (
        <AccessDialog member={accessMember} onOpenChange={() => setAccessFor(null)} />
      ) : null}
      {removing ? (
        <OffboardDialog
          member={removing}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          onDone={say}
        />
      ) : null}
      {pending?.kind === 'suspend' || pending?.kind === 'restore' ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={t(
            pending.kind === 'suspend' ? 'access.team.suspendTitle' : 'access.team.restoreTitle',
            { name: pending.member.displayName },
          )}
          confirmLabel={t(
            pending.kind === 'suspend' ? 'access.team.suspendSubmit' : 'access.team.restoreSubmit',
          )}
          variant={pending.kind === 'suspend' ? 'destructive-solid' : 'default'}
          testId="member-status-dialog"
          onConfirm={async () => {
            await setStatus.mutateAsync({
              id: pending.member.id,
              status: pending.kind === 'suspend' ? 'suspended' : 'active',
            });
            say(
              t(pending.kind === 'suspend' ? 'access.team.suspended' : 'access.team.restored', {
                name: pending.member.displayName,
              }),
            );
          }}
        >
          <p>
            {t(pending.kind === 'suspend' ? 'access.team.suspendBody' : 'access.team.restoreBody')}
          </p>
        </ConfirmDialog>
      ) : null}
      {pending?.kind === 'revoke-invite' ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={t('access.team.revokeInviteTitle', { email: pending.invitation.email })}
          confirmLabel={t('access.team.revokeInviteSubmit')}
          variant="destructive-solid"
          onConfirm={async () => {
            await revokeInvite.mutateAsync(pending.invitation.id);
            say(t('access.team.inviteRevoked', { email: pending.invitation.email }));
          }}
        >
          <p>{t('access.team.revokeInviteBody')}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
