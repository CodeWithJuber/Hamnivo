import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { directionOf, isLocale } from '../../i18n';
import type { McpServer } from '../../lib/actions';
import {
  aiPowerKeys,
  type McpCatalogPrompt,
  type McpCatalogResource,
  useMcpCatalog,
} from '../../lib/ai-power';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { CheckboxField } from '../Fields';
import { ActionError, QueryState } from '../States';

/** What a service said about something, shown as a quotation: it is text from another system. */
function Quoted({ children, label }: { children: string; label: string }) {
  return (
    <figure className="flex flex-col gap-0.5">
      <figcaption className="sr-only">{label}</figcaption>
      <blockquote className="border-s-2 border-border ps-2 text-sm text-text-secondary">
        <bdi>{children}</bdi>
      </blockquote>
    </figure>
  );
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ResourceItem({
  server,
  resource,
  manage,
}: {
  server: McpServer;
  resource: McpCatalogResource;
  manage: boolean;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const toggle = useStudioMutation(
    (aiReadable: boolean, tenant) =>
      api<McpCatalogResource>(`/v1/admin/mcp-servers/${server.id}/resources/${resource.id}`, {
        method: 'PATCH',
        body: { aiReadable },
        tenant,
      }),
    [aiPowerKeys.catalog(server.id)],
  );
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-resource={resource.uri}
    >
      <div className="flex min-w-0 flex-col">
        <p className="font-medium text-text">
          <bdi>{resource.title ?? resource.name}</bdi>
        </p>
        <p className="text-xs text-text-secondary">
          <bdi dir="ltr" className="font-mono break-all">
            {resource.uri}
          </bdi>
          {resource.mimeType ? (
            <>
              {' · '}
              <bdi dir="ltr">{resource.mimeType}</bdi>
            </>
          ) : null}
          {resource.sizeBytes !== null ? ` · ${bytes(resource.sizeBytes)}` : ''}
        </p>
      </div>
      {resource.description ? (
        <Quoted label={t('aiPower.mcp.catalog.fromService')}>{resource.description}</Quoted>
      ) : null}
      <CheckboxField
        id={`readable-${resource.id}`}
        label={t('aiPower.mcp.catalog.readable')}
        hint={t('aiPower.mcp.catalog.readableHint')}
        checked={resource.aiReadable}
        disabled={!manage || toggle.isPending}
        onCheckedChange={(on) =>
          void toggle
            .mutateAsync(on)
            .then(() => announce(t('aiPower.mcp.catalog.saved')))
            .catch(() => undefined)
        }
      />
      <ActionError error={isCancelled(toggle.error) ? null : toggle.error} />
    </li>
  );
}

function PromptItem({ prompt }: { prompt: McpCatalogPrompt }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border p-3">
      <p className="font-medium text-text">
        <bdi>{prompt.title ?? prompt.name}</bdi>
      </p>
      <p className="text-xs text-text-secondary">
        <bdi dir="ltr" className="font-mono">
          {prompt.name}
        </bdi>
      </p>
      {prompt.description ? (
        <Quoted label={t('aiPower.mcp.catalog.fromService')}>{prompt.description}</Quoted>
      ) : null}
      {prompt.arguments.length > 0 ? (
        <p className="text-xs text-text-secondary">
          {t('aiPower.mcp.catalog.arguments')}:{' '}
          {prompt.arguments.map((argument, index) => (
            <span key={argument.name}>
              {index > 0 ? ', ' : ''}
              <bdi dir="ltr" className="font-mono">
                {argument.name}
              </bdi>
              {argument.required ? ` (${t('aiPower.mcp.catalog.required')})` : ''}
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The resources and prompts an MCP service listed at its last check, quoted. Resources can be
 * switched on for agents with the "Read a resource" tool (a person decides which); prompts are
 * only listed.
 */
export function McpCatalogSheet({
  server,
  open,
  onOpenChange,
}: {
  server: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const catalog = useMcpCatalog(open ? server.id : undefined);
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={dir === 'rtl' ? 'left' : 'right'}
        showCloseButton={false}
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg"
        data-testid="catalog-sheet"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-border bg-bg px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <SheetTitle className="text-lg">
              <bdi>{t('aiPower.mcp.catalog.title', { name: server.label })}</bdi>
            </SheetTitle>
            <SheetDescription className="text-xs">
              {t('aiPower.mcp.catalog.description')}
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('app.close')}>
              <XIcon aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>
        <div className="flex flex-col gap-5 p-4">
          <QueryState query={catalog} label={t('aiPower.mcp.catalog.loading')}>
            {(data) => (
              <>
                <p className="text-xs text-text-secondary">
                  {data.syncedAt
                    ? t('aiPower.mcp.catalog.checked', { time: formatDateTime(data.syncedAt) })
                    : t('aiPower.mcp.catalog.neverChecked')}
                </p>
                <section aria-labelledby="catalog-resources" className="flex flex-col gap-2">
                  <h3 id="catalog-resources" className="text-sm font-semibold text-text">
                    {t('aiPower.mcp.catalog.resources')}
                  </h3>
                  <p className="text-xs text-text-secondary">
                    {t('aiPower.mcp.catalog.resourcesNote')}
                  </p>
                  {data.resources.length === 0 ? (
                    <p className="text-sm text-text-secondary">
                      {t('aiPower.mcp.catalog.noResources')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {data.resources.map((resource) => (
                        <ResourceItem
                          key={resource.id}
                          server={server}
                          resource={resource}
                          manage={can('tools.manage')}
                        />
                      ))}
                    </ul>
                  )}
                  {data.resources.length > 0 ? (
                    <p className="text-xs text-text-secondary">
                      {t('aiPower.mcp.catalog.needTool')}
                    </p>
                  ) : null}
                </section>
                <section aria-labelledby="catalog-prompts" className="flex flex-col gap-2">
                  <h3 id="catalog-prompts" className="text-sm font-semibold text-text">
                    {t('aiPower.mcp.catalog.prompts')}
                  </h3>
                  <p className="text-xs text-text-secondary">
                    {t('aiPower.mcp.catalog.promptsNote')}
                  </p>
                  {data.prompts.length === 0 ? (
                    <p className="text-sm text-text-secondary">
                      {t('aiPower.mcp.catalog.noPrompts')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {data.prompts.map((prompt) => (
                        <PromptItem key={prompt.id} prompt={prompt} />
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </QueryState>
        </div>
      </SheetContent>
    </Sheet>
  );
}
