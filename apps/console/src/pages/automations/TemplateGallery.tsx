import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useNavigate } from '@tanstack/react-router';
import { MessageSquareIcon, MonitorIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../components/States';
import {
  type AutomationTemplate,
  copyOf,
  TEMPLATES,
  type TemplateId,
} from '../../lib/automation-templates';
import { NAME_MAX, useCreateAutomation } from '../../lib/automations';
import type { BrandRef } from '../../lib/names';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';

/**
 * The rules a brand can start from. Choosing one saves it as a draft (nothing runs until it is
 * published) and opens the editor on it.
 */
export function TemplateGallery({
  brand,
  headingLevel = 3,
}: {
  brand: BrandRef;
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const navigate = useNavigate();
  const announce = useAnnouncer();
  const create = useCreateAutomation(brand.id);
  const [busy, setBusy] = useState<TemplateId | null>(null);
  const manage = can('automations.manage');
  const reason = manage ? null : t('automations.noPermission');
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  const use = async (template: AutomationTemplate) => {
    setBusy(template.id);
    const name = t(`automations.templates.${template.id}.name`).slice(0, NAME_MAX);
    try {
      const created = await create.mutateAsync({ name, definition: copyOf(template.definition) });
      announce(t('automations.gallery.created', { name }));
      await navigate({
        to: '/automations/$automationId',
        params: { automationId: created.id },
      });
    } catch {
      // Shown below the gallery.
    } finally {
      setBusy(null);
    }
  };

  const ready = TEMPLATES.filter((template) => !template.scratch);
  const scratch = TEMPLATES.filter((template) => template.scratch);
  return (
    <div className="flex flex-col gap-4" data-testid="template-gallery">
      <Heading className="text-base font-semibold text-text">
        {t('automations.gallery.ready')}
      </Heading>
      <ul className="grid gap-3 sm:grid-cols-2">
        {ready.map((template) => {
          const name = t(`automations.templates.${template.id}.name`);
          return (
            <li
              key={template.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
              data-testid="template"
              data-template={template.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text">{name}</span>
                <StatusBadge tone="neutral" icon={null}>
                  {template.kind === 'visitor'
                    ? t('automations.gallery.website')
                    : t('automations.gallery.chat')}
                </StatusBadge>
              </div>
              <p className="text-sm text-text-secondary">
                {t(`automations.templates.${template.id}.description`)}
                {template.choose === 'tag' ? ` ${t('automations.gallery.chooseTag')}` : null}
              </p>
              <ReasonedAction reason={reason} className="mt-auto">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  busy={busy === template.id}
                  disabled={busy !== null && busy !== template.id}
                  aria-label={t('automations.gallery.useLabel', { name })}
                  onClick={() => void use(template)}
                >
                  {t('automations.gallery.use')}
                </Button>
              </ReasonedAction>
            </li>
          );
        })}
      </ul>
      <Heading className="text-base font-semibold text-text">
        {t('automations.gallery.scratch')}
      </Heading>
      <p className="text-sm text-text-secondary">{t('automations.gallery.scratchDescription')}</p>
      <div className="flex flex-wrap gap-2">
        {scratch.map((template) => (
          <ReasonedAction key={template.id} reason={reason}>
            <Button
              type="button"
              variant="secondary"
              busy={busy === template.id}
              disabled={busy !== null && busy !== template.id}
              data-template={template.id}
              onClick={() => void use(template)}
            >
              {template.kind === 'visitor' ? (
                <MonitorIcon aria-hidden="true" />
              ) : (
                <MessageSquareIcon aria-hidden="true" />
              )}
              {template.kind === 'visitor'
                ? t('automations.gallery.website')
                : t('automations.gallery.chat')}
            </Button>
          </ReasonedAction>
        ))}
      </div>
      <ActionError error={isCancelled(create.error) ? null : create.error} />
    </div>
  );
}
