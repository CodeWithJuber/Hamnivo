import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { permissionOf, useTools } from '../lib/actions';
import { type AgentForm, FIELD_IDS } from '../lib/agent-form';
import { useTenant } from '../lib/tenant';
import { PermissionBadge } from '../pages/ToolsPage';
import { CheckboxField, TextField } from './Fields';

/**
 * The tools an agent may use and its action budgets (G07, G15; HNV-11-03). A grant lets the agent
 * call the tool; the tool's own policy still decides who approves. "May run without approval"
 * only matters where the tool's policy allows automatic runs at all.
 */
export function AgentTools({
  brandId,
  form,
  update,
  editable,
  errors,
}: {
  brandId: string;
  form: AgentForm;
  update: (patch: Partial<AgentForm>) => void;
  editable: boolean;
  errors: Record<string, string>;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const tools = useTools(brandId);
  const items = tools.data?.items ?? [];
  const granted = (toolId: string) => form.toolGrants.find((g) => g.toolId === toolId);
  const unknown = form.toolGrants.filter((g) => !items.some((tool) => tool.id === g.toolId));

  const setGrant = (toolId: string, grant: { autopilot: boolean } | null) =>
    update({
      toolGrants: grant
        ? [
            ...form.toolGrants.filter((g) => g.toolId !== toolId),
            { toolId, autopilot: grant.autopilot },
          ]
        : form.toolGrants.filter((g) => g.toolId !== toolId),
    });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">{t('tools.grants.hint')}</p>
      {!can('tools.read') ? (
        <p className="text-sm text-text-secondary">{t('tools.grants.hidden')}</p>
      ) : tools.isPending ? (
        <p className="text-sm text-text-secondary">{t('tools.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-secondary">
          {t('tools.grants.none')}{' '}
          <Link to="/tools" search={{ brand: brandId }} className="text-link underline">
            {t('tools.grants.manage')}
          </Link>
        </p>
      ) : (
        <ul id={FIELD_IDS.tools} tabIndex={-1} className="flex flex-col gap-3">
          {items.map((tool) => {
            const grant = granted(tool.id);
            const permission = permissionOf(tool);
            const automatic =
              tool.autopilot && tool.risk !== 'money' && tool.risk !== 'irreversible';
            return (
              <li
                key={tool.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3"
                data-grant={tool.name}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <CheckboxField
                    id={`agent-tool-${tool.id}`}
                    label={<bdi>{tool.title}</bdi>}
                    hint={t(`tools.risk.${tool.risk}`)}
                    checked={Boolean(grant)}
                    disabled={!editable || (!grant && permission === 'review')}
                    onCheckedChange={(checked) =>
                      setGrant(tool.id, checked ? { autopilot: false } : null)
                    }
                  />
                  <PermissionBadge tool={tool} />
                </div>
                {grant && automatic ? (
                  <div className="ps-7">
                    <CheckboxField
                      id={`agent-tool-${tool.id}-autopilot`}
                      label={t('tools.grants.autopilot')}
                      hint={t('tools.grants.autopilotHint')}
                      checked={grant.autopilot}
                      disabled={!editable}
                      onCheckedChange={(checked) => setGrant(tool.id, { autopilot: checked })}
                    />
                  </div>
                ) : null}
                {grant && permission === 'review' ? (
                  <p className="ps-7 text-sm text-warning">{t('tools.grants.inReview')}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {unknown.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {unknown.map((grant) => (
            <li
              key={grant.toolId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 p-3 text-sm"
            >
              <span>
                {t('tools.grants.unknown')}{' '}
                <bdi dir="ltr" className="font-mono text-xs">
                  {grant.toolId}
                </bdi>
              </span>
              {editable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setGrant(grant.toolId, null)}
                >
                  <Trash2Icon aria-hidden="true" />
                  {t('tools.grants.remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {errors[FIELD_IDS.tools] ? (
        <p role="alert" className="text-sm text-danger">
          {errors[FIELD_IDS.tools]}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={FIELD_IDS.maxCallsPerRun}
          label={t('tools.grants.maxCalls')}
          hint={t('tools.grants.maxCallsHint')}
          inputMode="numeric"
          value={form.maxCallsPerRun}
          disabled={!editable}
          onChange={(event) => update({ maxCallsPerRun: event.target.value })}
          error={errors[FIELD_IDS.maxCallsPerRun]}
        />
        <TextField
          id={FIELD_IDS.maxAutopilotPerConversation}
          label={t('tools.grants.maxAutopilot')}
          hint={t('tools.grants.maxAutopilotHint')}
          inputMode="numeric"
          value={form.maxAutopilotPerConversation}
          disabled={!editable}
          onChange={(event) => update({ maxAutopilotPerConversation: event.target.value })}
          error={errors[FIELD_IDS.maxAutopilotPerConversation]}
        />
      </div>
    </div>
  );
}
