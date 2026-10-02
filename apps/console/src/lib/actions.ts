/**
 * Tools, AI actions, approvals, handoff packets and simulations (G07–G15, boards 11 and 13): API
 * shapes and queries. The gateway checks every request against the person's grants and the
 * tool's own policy; what Studio shows is only ever a view of what they may see and do.
 */
import type * as C from '@hamnivo/contracts';
import type { StatusTone } from '@hamnivo/ui/components/status-badge';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { inboxKeys } from './inbox';
import { useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items } from './types';

export type ToolDefinition = C.ToolDefinition;
export type BuiltinTool = C.BuiltinTool;
export type McpServer = C.McpServer;
export type McpSyncResult = C.McpSyncResult;
export type ActionSettings = C.ActionSettings;
export type AiAction = C.Action;
export type ActionState = C.ActionState;
export type HandoffPacket = C.HandoffPacket;
export type SimulationSuite = C.SimulationSuite;
export type SimulationRun = C.SimulationRun;
export type SimulationCase = C.SimulationCase;
export type RiskClass = C.RiskClass;
export type ActionPage = { items: AiAction[]; nextCursor: string | null };

export const toolKeys = {
  tools: ['tools'] as const,
  builtins: ['tools', 'builtins'] as const,
  servers: ['mcp-servers'] as const,
  settings: ['action-settings'] as const,
  actions: ['actions'] as const,
  simulations: (agentId: string) => ['agents', agentId, 'simulations'] as const,
  simulationRuns: (agentId: string, suiteId: string) =>
    ['agents', agentId, 'simulations', suiteId, 'runs'] as const,
};

/** The brand's tools (all brands when none is given). */
export function useTools(brandId?: string | undefined) {
  const { can } = useTenant();
  const query = brandId ? `?${new URLSearchParams({ brandId })}` : '';
  return useStudioQuery<Items<ToolDefinition>>(
    [...toolKeys.tools, brandId ?? 'all'],
    `/v1/admin/tools${query}`,
    { enabled: can('tools.read') },
  );
}

export function useBuiltinTools() {
  const { can } = useTenant();
  return useStudioQuery<Items<BuiltinTool>>(toolKeys.builtins, '/v1/admin/tools/builtins', {
    enabled: can('tools.read'),
  });
}

export function useMcpServers(brandId: string | undefined) {
  const { can } = useTenant();
  const query = brandId ? `?${new URLSearchParams({ brandId })}` : '';
  return useStudioQuery<Items<McpServer>>(
    [...toolKeys.servers, brandId ?? 'all'],
    `/v1/admin/mcp-servers${query}`,
    { enabled: can('tools.read') && Boolean(brandId) },
  );
}

export function useActionSettings() {
  const { can } = useTenant();
  return useStudioQuery<ActionSettings>(toolKeys.settings, '/v1/admin/action-settings', {
    enabled: can('tools.read'),
  });
}

export interface ActionFilters {
  brandId?: string | undefined;
  toolId?: string | undefined;
  limit?: number;
}

/** AI actions, newest first; checked again every 10 s while one is still open. */
export function useActionLog(filters: ActionFilters) {
  const { can } = useTenant();
  const query = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  if (filters.brandId) query.set('brandId', filters.brandId);
  if (filters.toolId) query.set('toolId', filters.toolId);
  return useStudioQuery<ActionPage>([...toolKeys.actions, filters], `/v1/admin/actions?${query}`, {
    enabled: can('tools.read') && Boolean(filters.brandId || filters.toolId),
    refetchInterval: (data) => (data?.items.some((a) => OPEN_STATES.has(a.state)) ? 10_000 : false),
  });
}

export function useSimulations(agentId: string, enabled = true) {
  const { can } = useTenant();
  return useStudioQuery<Items<SimulationSuite>>(
    toolKeys.simulations(agentId),
    `/v1/admin/agents/${agentId}/simulations`,
    { enabled: enabled && can('agents.read') },
  );
}

export function useSimulationRuns(agentId: string, suiteId: string) {
  const { can } = useTenant();
  return useStudioQuery<Items<SimulationRun>>(
    toolKeys.simulationRuns(agentId, suiteId),
    `/v1/admin/agents/${agentId}/simulations/${suiteId}/runs`,
    { enabled: can('agents.read') },
  );
}

const conversationPath = (id: string, rest: string) =>
  `/v1/inbox/conversations/${encodeURIComponent(id)}${rest}`;

/**
 * The AI actions of one conversation. They reload with the conversation (the staff stream says
 * when it changed), and every 5 s while one is waiting for its result.
 */
export function useConversationActions(conversationId: string) {
  const { tenantId, can } = useTenant();
  return useQuery({
    queryKey: [tenantId, ...inboxKeys.part(conversationId, 'actions')],
    queryFn: ({ signal }) =>
      api<Items<AiAction>>(conversationPath(conversationId, '/actions'), {
        tenant: tenantId,
        signal,
      }),
    meta: { studio: true },
    enabled: can('conversations.read'),
    refetchInterval: (query) =>
      query.state.data?.items.some((a) => a.state === 'executing' || a.state === 'approved')
        ? 5000
        : false,
  });
}

export function useHandoffPackets(conversationId: string) {
  const { tenantId, can } = useTenant();
  return useQuery({
    queryKey: [tenantId, ...inboxKeys.part(conversationId, 'handoff-packets')],
    queryFn: ({ signal }) =>
      api<Items<HandoffPacket>>(conversationPath(conversationId, '/handoff-packets'), {
        tenant: tenantId,
        signal,
      }),
    meta: { studio: true },
    enabled: can('conversations.read'),
  });
}

/** Actions that still wait for a decision, a send or a result. */
export const OPEN_STATES = new Set<ActionState>([
  'awaiting_approval',
  'approved',
  'executing',
  'unknown',
]);

export const STATE_TONES: Record<ActionState, StatusTone> = {
  awaiting_approval: 'warning',
  approved: 'info',
  executing: 'info',
  completed: 'success',
  failed: 'danger',
  unknown: 'warning',
  declined: 'neutral',
  expired: 'neutral',
  superseded: 'neutral',
  cancelled: 'neutral',
  denied: 'danger',
};

/** How a tool is allowed to run, in the words the permission column uses. */
export type ToolPermission = 'automatic' | 'customer' | 'staff' | 'review' | 'off' | 'stopped';

export function permissionOf(tool: ToolDefinition): ToolPermission {
  if (tool.status === 'review') return 'review';
  if (tool.status === 'disabled') return 'off';
  if (tool.stopped) return 'stopped';
  if (tool.autopilot && tool.risk !== 'money' && tool.risk !== 'irreversible') return 'automatic';
  return tool.approver;
}

export const PERMISSION_TONES: Record<ToolPermission, StatusTone> = {
  automatic: 'info',
  customer: 'warning',
  staff: 'warning',
  review: 'neutral',
  off: 'neutral',
  stopped: 'danger',
};
