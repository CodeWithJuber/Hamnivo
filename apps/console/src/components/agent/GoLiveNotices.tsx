import type { AgentDetail } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../../lib/api';
import { useNames } from '../../lib/names';
import { keys, useAgentDetails, useAgents } from '../../lib/queries';
import { isCancelled, withReauth } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';

/**
 * Each brand whose AI does not really answer, with the one-step fix (G01). A brand's default
 * agent on the offline test model gives every customer the same fixed reply (production hands
 * those chats to people instead); one not yet published does not answer at all. "Make the
 * assistant live" moves it to the workspace's AI key, its brand's knowledge and memory, and
 * publishes it.
 */
export function GoLiveNotices() {
  const { can } = useTenant();
  const agents = useAgents();
  const defaults = (agents.data?.items ?? []).filter((a) => a.isDefault && a.status === 'active');
  const details = useAgentDetails(can('agents.publish') ? defaults.map((a) => a.id) : []);
  if (!can('agents.publish')) return null;
  const waiting = details
    .map((query) => query.data)
    .filter((detail): detail is AgentDetail => {
      if (!detail) return false;
      const model = (detail.published ?? detail.draft)?.config.model;
      return detail.published === null || model?.provider === 'mock';
    });
  if (waiting.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="go-live-notices">
      {waiting.map((detail) => (
        <GoLiveNotice key={detail.agent.id} detail={detail} />
      ))}
    </div>
  );
}

function GoLiveNotice({ detail }: { detail: AgentDetail }) {
  const { t } = useTranslation();
  const { tenantId } = useTenant();
  const names = useNames();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'key' | string | null>(null);
  const brand = names.brand(detail.agent.brandId) ?? detail.agent.name;
  const published = detail.published !== null;
  const titleId = `go-live-${detail.agent.id}`;

  const goLive = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const live = await withReauth(() =>
        api<AgentDetail>(`/v1/admin/agents/${detail.agent.id}/go-live`, {
          method: 'POST',
          tenant: tenantId,
          body: {},
        }),
      );
      const model = live.published?.config.model.modelId ?? '';
      announce(t('goLive.done', { brand, model }));
      await Promise.all([
        client.invalidateQueries({ queryKey: [tenantId, ...keys.agent(detail.agent.id)] }),
        client.invalidateQueries({ queryKey: [tenantId, ...keys.agents], exact: true }),
      ]);
    } catch (error) {
      if (isCancelled(error)) return;
      if (isApiError(error, 'VALIDATION_FAILED')) {
        setProblem(
          error.fields.some((field) => field.path === 'connectionId') ? 'key' : error.message,
        );
        return;
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="go-live-notice"
      data-agent-id={detail.agent.id}
      className="flex flex-col gap-3 rounded-lg border border-danger/50 bg-danger-subtle p-4 text-sm"
    >
      <div className="flex items-start gap-3">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-semibold text-text">
            {published ? t('goLive.testTitle', { brand }) : t('goLive.draftTitle', { brand })}
          </h2>
          <p className="text-text">{published ? t('goLive.testBody') : t('goLive.draftBody')}</p>
          <p className="text-text-secondary">{t('goLive.what')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 ps-8">
        <Button type="button" busy={busy} onClick={() => void goLive()}>
          {t('goLive.action')}
        </Button>
        {problem === 'key' ? (
          <Link to="/models" className="text-link underline underline-offset-4 hover:no-underline">
            {t('goLive.addKey')}
          </Link>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="ps-8 text-danger">
          {problem === 'key' ? t('goLive.needKey') : problem}
        </p>
      ) : null}
    </section>
  );
}
