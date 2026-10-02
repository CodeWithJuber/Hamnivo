import { Button } from '@hamnivo/ui/components/button';
import { Checkbox } from '@hamnivo/ui/components/checkbox';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Label } from '@hamnivo/ui/components/label';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useQuery } from '@tanstack/react-query';
import { ClockIcon, CopyIcon, LockIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { TextareaField, TextField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { directionOf, isLocale } from '../../i18n';
import { accessKeys, expandPatterns, groupByArea } from '../../lib/access';
import { areaLabel, permissionLabel } from '../../lib/access-text';
import { api, isApiError } from '../../lib/api';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { PermissionInfo, Role, RolePreview } from '../../lib/types';

const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * Patterns to save for a set of permissions: a whole area the role already held as `area.*` stays
 * a pattern (so permissions added to the catalog later keep following it); the rest are listed.
 */
export function patternsFor(
  selected: ReadonlySet<string>,
  catalog: readonly PermissionInfo[],
  original: readonly string[],
): string[] {
  const keys = catalog.map((p) => p.key);
  if (original.includes('*') && keys.every((k) => selected.has(k))) return ['*'];
  const patterns: string[] = [];
  for (const [area, permissions] of groupByArea(catalog)) {
    const all = permissions.every((p) => selected.has(p.key));
    if (all && (original.includes(`${area}.*`) || original.includes('*'))) {
      patterns.push(`${area}.*`);
      continue;
    }
    for (const p of permissions) if (selected.has(p.key)) patterns.push(p.key);
  }
  return patterns;
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

function Sensitive({ permission }: { permission: PermissionInfo }) {
  const { t } = useTranslation();
  if (!permission.mfa && !permission.stepUp) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {permission.mfa ? (
        <StatusBadge
          tone="warning"
          icon={<ShieldCheckIcon className="size-3.5" aria-hidden="true" />}
        >
          {t('access.roles.mfa')}
        </StatusBadge>
      ) : null}
      {permission.stepUp ? (
        <StatusBadge tone="neutral" icon={<ClockIcon className="size-3.5" aria-hidden="true" />}>
          {t('access.roles.stepUp')}
        </StatusBadge>
      ) : null}
    </span>
  );
}

/** The permissions a role holds, grouped by area, for reading only. */
function PermissionList({ keys, catalog }: { keys: string[]; catalog: PermissionInfo[] }) {
  const { t } = useTranslation();
  const held = new Set(keys);
  return (
    <div className="flex flex-col gap-4" data-testid="role-permissions">
      {groupByArea(catalog)
        .filter(([, permissions]) => permissions.some((p) => held.has(p.key)))
        .map(([area, permissions]) => (
          <section key={area} className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold text-text">{areaLabel(t, area)}</h4>
            <ul className="flex flex-col gap-1 text-sm">
              {permissions
                .filter((p) => held.has(p.key))
                .map((p) => (
                  <li key={p.key} className="flex flex-wrap items-center gap-2">
                    <span className="text-text">{permissionLabel(t, p)}</span>
                    <Sensitive permission={p} />
                  </li>
                ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function Preview({
  preview,
  loading,
  catalog,
}: {
  preview: RolePreview | undefined;
  loading: boolean;
  catalog: PermissionInfo[];
}) {
  const { t } = useTranslation();
  const byKey = new Map(catalog.map((p) => [p.key, p]));
  const label = (key: string) => {
    const permission = byKey.get(key);
    return permission ? permissionLabel(t, permission) : key;
  };
  const list = (keys: string[]) => keys.map(label).join(', ');
  return (
    <section
      aria-labelledby="role-preview-title"
      aria-busy={loading || undefined}
      data-testid="role-preview"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-4 text-sm"
    >
      <h3 id="role-preview-title" className="font-semibold text-text">
        {t('access.roles.preview')}
      </h3>
      {!preview ? (
        <p className="text-text-secondary">
          {loading ? t('access.roles.previewLoading') : t('access.roles.previewNothing')}
        </p>
      ) : (
        <>
          {preview.added.length === 0 && preview.removed.length === 0 ? (
            <p className="text-text-secondary">{t('access.roles.previewNothing')}</p>
          ) : (
            <dl className="grid gap-2 sm:grid-cols-[auto_1fr]">
              {preview.added.length > 0 ? (
                <>
                  <dt className="font-medium text-text">{t('access.roles.adds')}</dt>
                  <dd data-testid="preview-added">{list(preview.added)}</dd>
                </>
              ) : null}
              {preview.removed.length > 0 ? (
                <>
                  <dt className="font-medium text-text">{t('access.roles.removes')}</dt>
                  <dd data-testid="preview-removed">{list(preview.removed)}</dd>
                </>
              ) : null}
            </dl>
          )}
          {preview.addedSensitive.length > 0 ? (
            <p className="flex items-start gap-2 text-text">
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              {t('access.roles.sensitive', { list: list(preview.addedSensitive) })}
            </p>
          ) : null}
          {preview.outsideReach.length > 0 ? (
            <p role="alert" className="flex items-start gap-2 font-medium text-danger">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t('access.roles.outside', { list: list(preview.outsideReach) })}
            </p>
          ) : null}
          {preview.version !== null ? (
            <div className="flex flex-col gap-2">
              <h4 className="font-medium text-text">{t('access.roles.impact')}</h4>
              {preview.impact.length === 0 ? (
                <p className="text-text-secondary">{t('access.roles.impactNone')}</p>
              ) : (
                <ul className="flex flex-col gap-1" data-testid="preview-impact">
                  {preview.impact.map((entry) => (
                    <li key={entry.staffMemberId} data-person={entry.displayName}>
                      <bdi className="font-medium">{entry.displayName}</bdi>
                      {': '}
                      {[
                        entry.gains.length > 0
                          ? t('access.roles.gains', { list: list(entry.gains) })
                          : null,
                        entry.loses.length > 0
                          ? t('access.roles.loses', { list: list(entry.loses) })
                          : null,
                      ]
                        .filter(Boolean)
                        .join('; ') || t('access.roles.unchanged')}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

interface Draft {
  name: string;
  key: string;
  description: string;
  selected: Set<string>;
}

/**
 * The role editor (A12, board 22): permissions grouped by area, only those within the editor's
 * own reach can be ticked, and every change shows its diff and who gains or loses what before
 * saving. Built-in roles, and roles beyond the editor's reach, are read only.
 */
export function RoleEditor({
  role,
  seed,
  catalog,
  onClose,
  onDuplicate,
  onSaved,
}: {
  /** The role being edited (kept current by the list); null for a new one. */
  role: Role | null;
  /** What a new role starts with (when duplicating a role). */
  seed: { name: string; permissions: string[] } | null;
  catalog: PermissionInfo[];
  onClose: () => void;
  onDuplicate: (role: Role) => void;
  onSaved: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { tenantId, can } = useTenant();
  const announce = useAnnouncer();
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');
  const keys = useMemo(() => catalog.map((p) => p.key), [catalog]);
  // The version being edited. A newer one from someone else only replaces it when asked (Reload),
  // so a background refresh never wipes what the person is typing.
  const [base, setBase] = useState<Role | null>(role);
  const roleId = role?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only another role resets the base
  useEffect(() => setBase(role), [roleId]);
  const initial = useMemo<Draft>(
    () => ({
      name: base?.name ?? seed?.name ?? '',
      key: base?.key ?? '',
      description: base?.description ?? '',
      selected: new Set(expandPatterns(base?.permissions ?? seed?.permissions ?? [], keys)),
    }),
    [base, seed, keys],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [archiving, setArchiving] = useState(false);
  useEffect(() => {
    setDraft(initial);
    setErrors({});
    setConflict(false);
  }, [initial]);

  const readOnly = role !== null && (role.isPreset || !role.editable || !can('roles.manage'));
  const patterns = useMemo(
    () => patternsFor(draft.selected, catalog, base?.permissions ?? []),
    [draft.selected, catalog, base],
  );
  const debounced = useDebounced(patterns, 350);
  const dirty =
    !readOnly &&
    (draft.name !== initial.name ||
      draft.key !== initial.key ||
      draft.description !== initial.description ||
      draft.selected.size !== initial.selected.size ||
      [...draft.selected].some((k) => !initial.selected.has(k)));

  const preview = useQuery({
    queryKey: [tenantId, ...accessKeys.roles, 'preview', role?.id ?? 'new', debounced],
    queryFn: ({ signal }) =>
      api<RolePreview>('/v1/admin/roles/preview', {
        method: 'POST',
        tenant: tenantId,
        body: { ...(role ? { roleId: role.id } : {}), permissions: debounced },
        signal,
      }),
    enabled: !readOnly && can('roles.manage'),
    meta: { studio: true },
    placeholderData: (previous) => previous,
  });

  const save = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      role
        ? api<Role>(`/v1/admin/roles/${role.id}`, { method: 'PATCH', body, tenant })
        : api<Role>('/v1/admin/roles', { method: 'POST', body, tenant }),
    [accessKeys.roles, accessKeys.members, accessKeys.audit],
  );
  const archive = useStudioMutation(
    (id: string, tenant) => api<void>(`/v1/admin/roles/${id}`, { method: 'DELETE', tenant }),
    [accessKeys.roles, accessKeys.audit],
  );

  const toggle = (key: string, on: boolean) =>
    setDraft((current) => {
      const selected = new Set(current.selected);
      if (on) selected.add(key);
      else selected.delete(key);
      return { ...current, selected };
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = t('access.roles.nameRequired');
    if (!role && !KEY.test(draft.key)) next.key = t('access.roles.keyInvalid');
    if (draft.selected.size === 0) next.permissions = t('access.roles.pickOne');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setConflict(false);
    try {
      const saved = await save.mutateAsync(
        role
          ? {
              name: draft.name.trim(),
              description: draft.description.trim() || null,
              permissions: patterns,
              version: base?.version ?? role.version,
            }
          : {
              key: draft.key,
              name: draft.name.trim(),
              ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
              permissions: patterns,
            },
      );
      const message = t(role ? 'access.roles.saved' : 'access.roles.created', { name: saved.name });
      announce(message);
      onSaved(message);
    } catch (error) {
      if (isApiError(error, 'VERSION_CONFLICT')) setConflict(true);
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          if (field.path === 'key') fields.key = field.message;
          if (field.path === 'name') fields.name = field.message;
          if (field.path === 'permissions') fields.permissions = field.message;
        }
        if (Object.keys(fields).length > 0) setErrors(fields);
      }
    }
  };

  const close = () => {
    if (dirty && !save.isPending) setDiscarding(true);
    else onClose();
  };
  const outside = preview.data?.outsideReach.length ?? 0;
  const title = role ? role.name : t('access.roles.editorNew');

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetContent
          side={dir === 'rtl' ? 'left' : 'right'}
          className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl"
          data-testid="role-editor"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById('role-editor-title')?.focus();
          }}
        >
          <SheetHeader className="gap-1 border-b border-border p-4 text-start sm:p-6">
            <SheetTitle id="role-editor-title" tabIndex={-1} className="pe-8 text-xl">
              <bdi>{title}</bdi>
            </SheetTitle>
            <SheetDescription>
              {role
                ? t('access.roles.summary', {
                    kind: role.isPreset ? t('access.roles.builtIn') : t('access.roles.custom'),
                    members: t('access.roles.members', { n: role.memberCount }),
                  })
                : t('access.roles.intro')}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-5 p-4 sm:p-6">
            {readOnly && role ? (
              <>
                <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-3 text-sm text-text">
                  <LockIcon className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
                  {role.isPreset ? t('access.roles.presetNote') : t('access.roles.beyondNote')}
                </p>
                {role.description ? (
                  <p className="text-sm text-text-secondary">{role.description}</p>
                ) : null}
                <PermissionList keys={expandPatterns(role.permissions, keys)} catalog={catalog} />
                {can('roles.manage') ? (
                  <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() => onDuplicate(role)}
                    data-testid="duplicate-role"
                  >
                    <CopyIcon aria-hidden="true" />
                    {t('access.roles.duplicate')}
                  </Button>
                ) : null}
              </>
            ) : (
              <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
                <FormErrorSummary
                  title={t('auth.errorSummary')}
                  errors={Object.entries(errors).map(([field, message]) => ({
                    fieldId: field === 'permissions' ? 'role-permissions' : `role-${field}`,
                    message,
                  }))}
                />
                <TextField
                  id="role-name"
                  label={t('access.roles.name')}
                  value={draft.name}
                  maxLength={80}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  error={errors.name}
                />
                {role ? null : (
                  <TextField
                    id="role-key"
                    label={t('access.roles.key')}
                    hint={t('access.roles.keyHint')}
                    value={draft.key}
                    dir="ltr"
                    maxLength={40}
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                    error={errors.key}
                  />
                )}
                <TextareaField
                  id="role-description"
                  label={t('access.roles.description')}
                  labelNote={t('app.optional')}
                  value={draft.description}
                  maxLength={400}
                  rows={2}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
                <fieldset
                  id="role-permissions"
                  tabIndex={-1}
                  className="flex flex-col gap-4"
                  aria-describedby={errors.permissions ? 'role-permissions-error' : undefined}
                >
                  <legend className="mb-2 text-sm font-semibold text-text">
                    {t('access.roles.permissionsLegend')}
                  </legend>
                  {errors.permissions ? (
                    <p id="role-permissions-error" className="text-sm text-danger">
                      {errors.permissions}
                    </p>
                  ) : null}
                  {groupByArea(catalog).map(([area, permissions]) => (
                    <fieldset
                      key={area}
                      className="flex flex-col gap-2 rounded-lg border border-border p-3"
                    >
                      <legend className="px-1 text-sm font-medium text-text">
                        {areaLabel(t, area)}
                      </legend>
                      {permissions.map((permission) => {
                        const id = `perm-${permission.key.replace('.', '-')}`;
                        const checked = draft.selected.has(permission.key);
                        const blocked = !permission.grantable && !checked;
                        return (
                          <div key={permission.key} className="flex items-start gap-3">
                            <Checkbox
                              id={id}
                              checked={checked}
                              disabled={blocked}
                              onCheckedChange={(value) => toggle(permission.key, value === true)}
                              aria-describedby={blocked ? `${id}-note` : undefined}
                              className="mt-0.5"
                              data-permission={permission.key}
                            />
                            <div className="flex min-w-0 flex-col gap-1">
                              <Label htmlFor={id} className="leading-snug">
                                {permissionLabel(t, permission)}
                              </Label>
                              <span className="flex flex-wrap gap-1">
                                <Sensitive permission={permission} />
                                {blocked ? (
                                  <span
                                    id={`${id}-note`}
                                    className="flex items-center gap-1 text-xs text-text-secondary"
                                  >
                                    <LockIcon className="size-3.5" aria-hidden="true" />
                                    {t('access.roles.notGrantable')}
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </fieldset>
                  ))}
                </fieldset>
                <Preview preview={preview.data} loading={preview.isFetching} catalog={catalog} />
                {conflict ? (
                  <div
                    role="alert"
                    className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm"
                  >
                    <p className="text-text">{t('access.roles.conflict')}</p>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      onClick={() => {
                        save.reset();
                        setBase(role);
                      }}
                    >
                      {t('access.roles.reload')}
                    </Button>
                  </div>
                ) : (
                  <ActionError error={isCancelled(save.error) ? null : save.error} />
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                  {role ? (
                    <div className="flex flex-col gap-1">
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={role.memberCount > 0}
                        aria-describedby={role.memberCount > 0 ? 'role-held-note' : undefined}
                        onClick={() => setArchiving(true)}
                      >
                        {t('access.roles.archive')}
                      </Button>
                      {role.memberCount > 0 ? (
                        <p id="role-held-note" className="max-w-56 text-xs text-text-secondary">
                          {t('access.roles.heldNote')}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <span />
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" onClick={close}>
                      {t('app.cancel')}
                    </Button>
                    <Button
                      type="submit"
                      busy={save.isPending}
                      disabled={outside > 0}
                      data-testid="save-role"
                    >
                      {role ? t('access.roles.save') : t('access.roles.create')}
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </SheetContent>
      </Sheet>
      {discarding ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDiscarding(false);
          }}
          title={t('access.roles.discardTitle')}
          confirmLabel={t('access.roles.close')}
          variant="destructive-solid"
          onConfirm={async () => onClose()}
        >
          <p>{t('access.roles.discardBody')}</p>
        </ConfirmDialog>
      ) : null}
      {archiving && role ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setArchiving(false);
          }}
          title={t('access.roles.archiveTitle', { name: role.name })}
          confirmLabel={t('access.roles.archiveSubmit')}
          variant="destructive-solid"
          onConfirm={async () => {
            await archive.mutateAsync(role.id);
            const message = t('access.roles.archived', { name: role.name });
            announce(message);
            onSaved(message);
          }}
        >
          <p>{t('access.roles.archiveBody')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
