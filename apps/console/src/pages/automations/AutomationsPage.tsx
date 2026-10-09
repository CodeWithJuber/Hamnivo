import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { Switch } from '@hamnivo/ui/components/switch';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CopyIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog } from '../../components/AppDialog';
import { BrandPicker, useChosenBrand } from '../../components/BrandPicker';
import { TextField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { PageHeader, Section } from '../../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../../components/States';
import {
  type Automation,
  type AutomationList,
  type AutomationOptions,
  activityText,
  deleteRequest,
  enabledRequest,
  NAME_MAX,
  type StatusKey,
  statusOf,
  summaryOf,
  useAutomationChange,
  useAutomationOptions,
  useAutomations,
  useCreateAutomation,
  useSavePromptLimits,
} from '../../lib/automations';
import { DOCS } from '../../lib/docs';
import type { BrandRef } from '../../lib/names';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { AutomationsSearch } from '../../routes/_studio/automations/index';
import { TemplateGallery } from './TemplateGallery';

export const STATUS_TONES: Record<StatusKey, StatusTone> = {
  off: 'neutral',
  draft: 'info',
  changes: 'warning',
  published: 'success',
};

/** "Published v3", "Draft only", … */
export function StatusText({ automation }: { automation: Automation }) {
  const { t } = useTranslation();
  const status = statusOf(automation);
  return (
    <StatusBadge tone={STATUS_TONES[status.key]} data-testid="automation-status">
      {t(`automations.status.${status.key}`, { version: status.version ?? 0 })}
    </StatusBadge>
  );
}

/** Names of the brand's teams for summaries. */
export const teamNames = (options: AutomationOptions | undefined) => {
  const names = new Map((options?.teams ?? []).map((team) => [team.id, team.name]));
  return { team: (id: string) => names.get(id) };
};

function AutomationRow({
  automation,
  options,
}: {
  automation: Automation;
  options: AutomationOptions | undefined;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const manage = can('automations.manage');
  const reason = manage ? null : t('automations.noPermission');
  const toggle = useAutomationChange(automation.id, enabledRequest);
  const remove = useAutomationChange(automation.id, deleteRequest);
  const duplicate = useCreateAutomation(automation.brandId);
  const [deleting, setDeleting] = useState(false);
  const titleId = `automation-${automation.id}-title`;
  const name = automation.name;

  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      data-testid="automation-row"
      data-automation={automation.id}
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={titleId} className="font-semibold text-text">
            <bdi>{name}</bdi>
          </h3>
          <p className="text-sm text-text-secondary" data-testid="automation-summary">
            {summaryOf(automation.draft, t, teamNames(options))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ReasonedAction reason={reason}>
            <Switch
              id={`automation-${automation.id}-enabled`}
              checked={automation.enabled}
              disabled={toggle.isPending}
              aria-label={t('automations.list.switchLabel', { name })}
              data-testid="automation-enabled"
              onCheckedChange={async (enabled) => {
                try {
                  await toggle.mutateAsync(enabled);
                  announce(
                    enabled
                      ? t('automations.list.turnedOn', { name })
                      : t('automations.list.turnedOff', { name }),
                  );
                } catch {
                  // Shown below the row.
                }
              }}
            />
          </ReasonedAction>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-text-secondary">
        <StatusText automation={automation} />
        <span data-testid="automation-activity">{activityText(automation, t)}</span>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link
            to="/automations/$automationId"
            params={{ automationId: automation.id }}
            aria-label={t('automations.list.editLabel', { name })}
          >
            <PencilIcon aria-hidden="true" />
            {t('automations.list.edit')}
          </Link>
        </Button>
        <ReasonedAction reason={reason}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            busy={duplicate.isPending}
            aria-label={t('automations.list.duplicateLabel', { name })}
            onClick={async () => {
              const copy = t('automations.list.copyName', { name }).slice(0, NAME_MAX);
              try {
                await duplicate.mutateAsync({ name: copy, definition: automation.draft });
                announce(t('automations.list.duplicated', { name: copy }));
              } catch {
                // Shown below the row.
              }
            }}
          >
            <CopyIcon aria-hidden="true" />
            {t('automations.list.duplicate')}
          </Button>
        </ReasonedAction>
        <ReasonedAction reason={reason}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('automations.list.deleteLabel', { name })}
            onClick={() => setDeleting(true)}
          >
            <Trash2Icon aria-hidden="true" />
            {t('automations.list.delete')}
          </Button>
        </ReasonedAction>
      </div>
      <ActionError
        error={[toggle.error, duplicate.error].find((error) => error && !isCancelled(error))}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('automations.list.deleteTitle', { name })}
        confirmLabel={t('automations.list.deleteConfirm')}
        variant="destructive-solid"
        testId="delete-automation-dialog"
        fallbackFocus={() => document.getElementById('page-title')}
        onConfirm={async () => {
          await remove.mutateAsync(undefined);
          announce(t('automations.list.deleted', { name }));
        }}
      >
        <p>{t('automations.list.deleteBody')}</p>
      </ConfirmDialog>
    </li>
  );
}

/** A whole number within bounds, or null. */
const whole = (value: string, min: number, max: number): number | null =>
  /^\s*\d+\s*$/.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;

/** How often website prompts may show to one visitor, for the brand. */
function PromptLimitsCard({ brand, list }: { brand: BrandRef; list: AutomationList }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const save = useSavePromptLimits(brand.id);
  const [maxPerDay, setMaxPerDay] = useState(String(list.promptLimits.maxPerDay));
  const [dismissHours, setDismissHours] = useState(String(list.promptLimits.dismissHours));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const manage = can('automations.manage');
  const dirty =
    maxPerDay.trim() !== String(list.promptLimits.maxPerDay) ||
    dismissHours.trim() !== String(list.promptLimits.dismissHours);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const perDay = whole(maxPerDay, 1, 3);
    const hours = whole(dismissHours, 1, 168);
    const next: Record<string, string> = {};
    if (perDay === null) next.maxPerDay = t('automations.limits.invalid', { min: 1, max: 3 });
    if (hours === null) next.dismissHours = t('automations.limits.invalid', { min: 1, max: 168 });
    setErrors(next);
    if (perDay === null || hours === null) return;
    try {
      await save.mutateAsync({ maxPerDay: perDay, dismissHours: hours });
      announce(t('automations.limits.saved', { name: brand.name }));
    } catch {
      // Shown below the form.
    }
  };

  return (
    <Section
      id="prompt-limits"
      title={t('automations.limits.title')}
      description={t('automations.limits.description')}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={submit}
        noValidate
        data-testid="prompt-limits"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="prompt-limits-maxPerDay"
            label={t('automations.limits.maxPerDay')}
            hint={t('automations.limits.maxPerDayHint')}
            inputMode="numeric"
            value={maxPerDay}
            error={errors.maxPerDay}
            onChange={(event) => setMaxPerDay(event.target.value)}
          />
          <TextField
            id="prompt-limits-dismissHours"
            label={t('automations.limits.dismissHours')}
            hint={t('automations.limits.dismissHoursHint')}
            inputMode="numeric"
            value={dismissHours}
            error={errors.dismissHours}
            onChange={(event) => setDismissHours(event.target.value)}
          />
        </div>
        <ActionError error={isCancelled(save.error) ? null : save.error} />
        <ReasonedAction reason={manage ? null : t('automations.noPermission')}>
          <Button type="submit" variant="secondary" busy={save.isPending} disabled={!dirty}>
            {t('automations.limits.save')}
          </Button>
        </ReasonedAction>
      </form>
    </Section>
  );
}

function KindSection({
  kind,
  items,
  options,
}: {
  kind: 'visitor' | 'conversation';
  items: Automation[];
  options: AutomationOptions | undefined;
}) {
  const { t } = useTranslation();
  return (
    <Section
      id={`automations-${kind}`}
      title={t(`automations.sections.${kind}.title`)}
      description={t(`automations.sections.${kind}.description`)}
    >
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
          {t('automations.sections.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid={`automations-${kind}`}>
          {items.map((automation) => (
            <AutomationRow key={automation.id} automation={automation} options={options} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function BrandAutomations({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const list = useAutomations(brand.id);
  const options = useAutomationOptions(brand.id);
  const [gallery, setGallery] = useState(false);
  const manage = can('automations.manage');
  return (
    <QueryState query={list} label={t('automations.loading')}>
      {(data) => {
        const visitor = data.items.filter((item) => item.kind === 'visitor');
        const conversation = data.items.filter((item) => item.kind === 'conversation');
        return (
          <div className="flex flex-col gap-6" data-testid="automations" data-brand={brand.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <GuideLink href={DOCS.automation.automations}>{t('automations.guide')}</GuideLink>
              {data.items.length > 0 ? (
                <ReasonedAction reason={manage ? null : t('automations.noPermission')}>
                  <Button
                    type="button"
                    onClick={() => setGallery(true)}
                    data-testid="new-automation"
                  >
                    <PlusIcon aria-hidden="true" />
                    {t('automations.new')}
                  </Button>
                </ReasonedAction>
              ) : null}
            </div>
            {data.items.length === 0 ? (
              <Section
                id="automations-gallery"
                title={t('automations.gallery.title')}
                description={t('automations.gallery.description')}
              >
                <TemplateGallery brand={brand} />
              </Section>
            ) : (
              <>
                <KindSection kind="visitor" items={visitor} options={options.data} />
                <KindSection kind="conversation" items={conversation} options={options.data} />
              </>
            )}
            <PromptLimitsCard
              key={`${data.promptLimits.maxPerDay}-${data.promptLimits.dismissHours}`}
              brand={brand}
              list={data}
            />
            <AppDialog
              open={gallery}
              onOpenChange={setGallery}
              title={t('automations.gallery.title')}
              description={t('automations.gallery.description')}
              className="sm:max-w-3xl"
              testId="template-dialog"
            >
              <TemplateGallery brand={brand} />
            </AppDialog>
          </div>
        );
      }}
    </QueryState>
  );
}

/**
 * Automations of one brand (Settings, G21): website prompts and chat rules, each with what it
 * does in one sentence, where it stands, what it did this week and a switch; new ones start from
 * a template. The website prompts' limits are set here too.
 */
export function AutomationsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/automations/' });
  const navigate = useNavigate({ from: '/automations/' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  const query = {
    data: brands.items,
    error: brands.error,
    isPending: brands.pending,
    isRefetching: brands.isRefetching,
    refetch: brands.refetch,
  };
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('automations.title')} description={t('automations.description')} />
      <QueryState
        query={query}
        label={t('automations.loading')}
        permitted={can('automations.read') && brands.permitted}
        forbidden={
          <Forbidden
            title={t('automations.forbidden.title')}
            description={t('automations.forbidden.description')}
          />
        }
        isEmpty={() => active.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('automations.noBrands.title')}
            description={t('automations.noBrands.description')}
            action={
              can('brands.manage') ? (
                <Button asChild>
                  <Link to="/brands">{t('automations.noBrands.action')}</Link>
                </Button>
              ) : undefined
            }
          />
        }
      >
        {() =>
          chosen ? (
            <div className="flex flex-col gap-6">
              <BrandPicker
                id="automations-brand"
                label={t('automations.brand')}
                brands={active}
                value={chosen.id}
                onChange={(brand) =>
                  void navigate({ search: (current: AutomationsSearch) => ({ ...current, brand }) })
                }
              />
              <BrandAutomations key={chosen.id} brand={chosen} />
            </div>
          ) : null
        }
      </QueryState>
    </div>
  );
}
