/**
 * AI power tools (D10, G04, G17): signing in to MCP servers, what they list besides tools, and the
 * catalog of services whose vendors run an MCP server: API shapes and queries. Everything a service
 * says about itself is untrusted text; the pages show it quoted.
 */
import type * as C from '@hamnivo/contracts';
import type { i18n as I18n, TFunction } from 'i18next';
import { useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items } from './types';

export type McpPreset = C.McpPreset;
export type McpCatalog = C.McpCatalog;
export type McpCatalogResource = C.McpCatalogResource;
export type McpCatalogPrompt = C.McpCatalogPrompt;
export type McpOAuthStart = C.McpOAuthStart;

export const aiPowerKeys = {
  presets: ['mcp-presets'] as const,
  /** Under the servers' key, so checking a server reloads what it lists. */
  catalog: (serverId: string) => ['mcp-servers', serverId, 'catalog'] as const,
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
