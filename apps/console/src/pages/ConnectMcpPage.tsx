import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2Icon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import type { McpServer, McpSyncResult } from '../lib/actions';
import { toolKeys } from '../lib/actions';
import { api, isApiError } from '../lib/api';
import { useStudioMutation } from '../lib/queries';

type Outcome =
  | { kind: 'working' }
  | { kind: 'done'; server: McpServer; synced: boolean }
  | { kind: 'failed'; message: string };

/**
 * Finishes signing in to an MCP service (D10): the service's sign-in page sent the browser here
 * with a code. It is passed on to the gateway once, and then removed from the address bar, so it
 * is not kept in the history. The tools of the service are listed right away, and wait for review
 * like every tool from a service.
 */
export function ConnectMcpPage() {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/connect/mcp' });
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' });
  const started = useRef(false);

  const complete = useStudioMutation(
    (body: Record<string, string>, tenant) =>
      api<McpServer>('/v1/admin/mcp-oauth/complete', { method: 'POST', body, tenant }),
    [toolKeys.servers],
  );
  const sync = useStudioMutation(
    (serverId: string, tenant) =>
      api<McpSyncResult>(`/v1/admin/mcp-servers/${serverId}/sync`, { method: 'POST', tenant }),
    [toolKeys.servers, toolKeys.tools],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the answer is used once, as it was on arrival
  useEffect(() => {
    // Strict mode runs effects twice in development; a code can be used only once.
    if (started.current) return;
    started.current = true;
    const { code, state, error, error_description: errorDescription, iss } = search;
    void navigate({ to: '/connect/mcp', search: {}, replace: true });
    if (!state || (!code && !error)) {
      setOutcome({ kind: 'failed', message: t('aiPower.mcp.callback.missing') });
      return;
    }
    void (async () => {
      try {
        const server = await complete.mutateAsync({
          state,
          ...(code ? { code } : {}),
          ...(error ? { error } : {}),
          ...(errorDescription ? { errorDescription } : {}),
          ...(iss ? { iss } : {}),
        });
        let synced = true;
        try {
          await sync.mutateAsync(server.id);
        } catch {
          synced = false;
        }
        setOutcome({ kind: 'done', server, synced });
        announce(t('aiPower.mcp.callback.done', { name: server.label }));
      } catch (failure) {
        const reason = isApiError(failure) ? failure.problem?.reason : undefined;
        setOutcome({
          kind: 'failed',
          message:
            reason === 'sign_in_ended'
              ? t('aiPower.mcp.callback.ended')
              : reason === 'sign_in_refused'
                ? isApiError(failure) && failure.problem?.detail
                  ? failure.problem.detail
                  : t('aiPower.mcp.callback.refused')
                : isApiError(failure) && failure.problem?.detail
                  ? failure.problem.detail
                  : t('aiPower.mcp.callback.failed'),
        });
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('aiPower.mcp.callback.title')} />
      <div
        className="flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-surface p-4"
        role="status"
        aria-live="polite"
        data-testid="connect-mcp"
      >
        {outcome.kind === 'working' ? (
          <p className="flex items-center gap-2 text-sm text-text">
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            {t('aiPower.mcp.callback.working')}
          </p>
        ) : null}
        {outcome.kind === 'done' ? (
          <>
            <p className="flex items-center gap-2 font-medium text-text">
              <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
              <bdi>{t('aiPower.mcp.callback.done', { name: outcome.server.label })}</bdi>
            </p>
            <p className="text-sm text-text-secondary">
              {outcome.synced
                ? t('aiPower.mcp.callback.synced')
                : t('aiPower.mcp.callback.syncFailed')}
            </p>
            <Button asChild>
              <Link to="/tools" search={{ brand: outcome.server.brandId }}>
                {t('aiPower.mcp.callback.back')}
              </Link>
            </Button>
          </>
        ) : null}
        {outcome.kind === 'failed' ? (
          <>
            <p className="flex items-start gap-2 text-sm font-medium text-text" role="alert">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              <bdi>{outcome.message}</bdi>
            </p>
            <Button asChild variant="secondary">
              <Link to="/tools">{t('aiPower.mcp.callback.back')}</Link>
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
