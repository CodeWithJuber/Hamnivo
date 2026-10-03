/**
 * AI power tools (D10, G04, G17, G11, H06): signing in to MCP servers, what they list besides tools,
 * the catalog of services whose vendors run an MCP server, websites as knowledge, the memory card
 * beside a conversation and the answer of "Test your AI": API shapes and queries. Everything a
 * service says about itself is untrusted text; the pages show it quoted.
 */
import type * as C from '@hamnivo/contracts';
import type { i18n as I18n, TFunction } from 'i18next';
import { keys, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items, MemoryCustomerDetail } from './types';

export type McpPreset = C.McpPreset;
export type McpCatalog = C.McpCatalog;
export type McpCatalogResource = C.McpCatalogResource;
export type McpCatalogPrompt = C.McpCatalogPrompt;
export type McpOAuthStart = C.McpOAuthStart;
export type KnowledgeWebSource = C.KnowledgeWebSource;
export type KnowledgeWebPage = C.KnowledgeWebPage;
export type WebSyncSummary = C.WebSyncSummary;
export type PlaygroundResult = C.PlaygroundResult;
export type PlaygroundAction = C.PlaygroundAction;
export type PlaygroundSource = C.PlaygroundSource;
export type PlaygroundStep = C.PlaygroundStep;
export type ConversationMemoryCustomer = C.ConversationMemoryCustomer;

export const aiPowerKeys = {
  presets: ['mcp-presets'] as const,
  /** Under the servers' key, so checking a server reloads what it lists. */
  catalog: (serverId: string) => ['mcp-servers', serverId, 'catalog'] as const,
  /** Under the knowledge key: a website is a knowledge source whose documents are its pages. */
  webSources: ['knowledge', 'web-sources'] as const,
  webPages: (webSourceId: string) => ['knowledge', 'web-sources', webSourceId, 'pages'] as const,
  /** Under the memory key, so what a memory change reloads includes the inbox card. */
  conversationMemory: (conversationId: string) =>
    ['memory', 'conversations', conversationId] as const,
};

/** Remote MCP servers that vendors run themselves, each with the vendor page that names it. */
export function useMcpPresets() {
  const { can } = useTenant();
  return useStudioQuery<Items<McpPreset>>(aiPowerKeys.presets, '/v1/admin/mcp-presets', {
    enabled: can('tools.read'),
  });
}

/** The resources and prompts a server listed at its last check. */
export function useMcpCatalog(serverId: string | undefined) {
  const { can } = useTenant();
  return useStudioQuery<McpCatalog>(
    aiPowerKeys.catalog(serverId ?? ''),
    `/v1/admin/mcp-servers/${serverId}/catalog`,
    { enabled: can('tools.read') && Boolean(serverId) },
  );
}

/** How often Studio asks again while a website is waiting to be read or being read. */
const WEB_POLL_MS = 3000;

/** Websites kept as knowledge, with how their last read went; refreshed while one is being read. */
export function useWebSources() {
  const { can } = useTenant();
  return useStudioQuery<Items<KnowledgeWebSource>>(
    aiPowerKeys.webSources,
    '/v1/admin/knowledge/web-sources',
    {
      enabled: can('knowledge.read'),
      refetchInterval: (data) =>
        data?.items.some((web) => web.state !== 'idle') ? WEB_POLL_MS : false,
    },
  );
}

/** The pages of one website and what the last read said about each. */
export function useWebPages(webSourceId: string | undefined, enabled: boolean) {
  const { can } = useTenant();
  return useStudioQuery<Items<KnowledgeWebPage>>(
    aiPowerKeys.webPages(webSourceId ?? ''),
    `/v1/admin/knowledge/web-sources/${webSourceId}/pages`,
    { enabled: enabled && can('knowledge.read') && Boolean(webSourceId) },
  );
}

/** Which customer's memory a conversation belongs to (none for a visitor nobody knows). */
export function useConversationMemoryCustomer(conversationId: string) {
  const { can } = useTenant();
  return useStudioQuery<ConversationMemoryCustomer>(
    aiPowerKeys.conversationMemory(conversationId),
    `/v1/admin/memory/conversations/${conversationId}`,
    { enabled: can('memory.read') },
  );
}

/**
 * One customer's memory once the customer is known. It shares its key with the memory page's
 * query, so a correction made on either reloads both.
 */
export function useMemoryOf(customerId: string | null) {
  const { can } = useTenant();
  return useStudioQuery<MemoryCustomerDetail>(
    keys.memoryCustomer(customerId ?? ''),
    `/v1/admin/memory/customers/${customerId}`,
    {
      enabled: can('memory.read') && customerId !== null,
      refetchInterval: (data) =>
        data?.deletions.some((deletion) => deletion.status === 'pending') ? 2000 : false,
    },
  );
}

/**
 * What a preset says about itself, in the person's language when Studio has it (by the preset's
 * id), and in the English the catalog carries when it does not.
 */
export function presetText(
  t: TFunction,
  i18n: I18n,
  kind: 'summaries' | 'notes',
  preset: McpPreset,
): string {
  const key = `aiPower.mcp.preset.${kind}.${preset.id}`;
  if (i18n.exists(key)) return (t as unknown as (key: string) => string)(key);
  return kind === 'summaries' ? preset.summary : (preset.note ?? '');
}
