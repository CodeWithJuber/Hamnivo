import { z } from 'zod';
import { Run } from './agents.js';
import { Cursor, page } from './common.js';
import type { RouteDef } from './routes.js';
import {
  Action,
  ActionSettings,
  ActionState,
  BuiltinTool,
  CreateMcpServerRequest,
  CreateToolRequest,
  DecideActionRequest,
  HandoffPacket,
  McpServer,
  McpSyncResult,
  SaveSimulationSuiteRequest,
  SimulationRun,
  SimulationSuite,
  ToolDefinition,
  UpdateActionSettingsRequest,
  UpdateMcpServerRequest,
  UpdateToolRequest,
} from './tools.js';

const toolParams = z.object({ toolId: z.string().meta({ description: 'Tool ID (tool_…)' }) });
const serverParams = z.object({
  serverId: z.string().meta({ description: 'MCP server ID (mcp_…)' }),
});
const conversationParams = z.object({
  conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
});
const actionParams = conversationParams.extend({
  actionId: z.string().meta({ description: 'Action ID (act_…)' }),
});
const agentParams = z.object({ agentId: z.string().meta({ description: 'Agent ID (agt_…)' }) });
const suiteParams = agentParams.extend({
  suiteId: z.string().meta({ description: 'Simulation suite ID (sim_…)' }),
});
const brandQuery = z.object({ brandId: z.string().optional() });

/**
 * Tools, MCP servers, action policies, AI actions and simulations in Studio (staff session,
 * X-Hamnivo-Tenant). Policy changes need a fresh sign-in (tools.manage).
 */
export const toolAdminRoutes = {
  listTools: {
    method: 'get',
    path: '/v1/admin/tools',
    operationId: 'listTools',
    summary: 'Tools of the tenant or one brand, with their action policies (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    query: brandQuery,
    success: {
      status: 200,
      description: 'Tools',
      schema: z.object({ items: z.array(ToolDefinition) }),
    },
  },
  listBuiltinTools: {
    method: 'get',
    path: '/v1/admin/tools/builtins',
    operationId: 'listBuiltinTools',
    summary: 'Built-in tools that can be added to a brand (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Built-in tools',
      schema: z.object({ items: z.array(BuiltinTool) }),
    },
  },
  createTool: {
    method: 'post',
    path: '/v1/admin/tools',
    operationId: 'createTool',
    summary: 'Add a built-in tool to a brand (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    body: CreateToolRequest,
    idempotent: true,
    success: { status: 201, description: 'Tool added', schema: ToolDefinition },
  },
  getTool: {
    method: 'get',
    path: '/v1/admin/tools/{toolId}',
    operationId: 'getTool',
    summary: 'One tool with its policy (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: toolParams,
    success: { status: 200, description: 'Tool', schema: ToolDefinition },
  },
  updateTool: {
    method: 'patch',
    path: '/v1/admin/tools/{toolId}',
    operationId: 'updateTool',
    summary:
      'Change a tool’s policy, enable a reviewed MCP tool or disable one; pending approvals are superseded (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: toolParams,
    body: UpdateToolRequest,
    success: { status: 200, description: 'Tool', schema: ToolDefinition },
  },
  listMcpServers: {
    method: 'get',
    path: '/v1/admin/mcp-servers',
    operationId: 'listMcpServers',
    summary: 'Remote MCP servers the brand’s tools come from (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    query: brandQuery,
    success: {
      status: 200,
      description: 'Servers',
      schema: z.object({ items: z.array(McpServer) }),
    },
  },
  createMcpServer: {
    method: 'post',
    path: '/v1/admin/mcp-servers',
    operationId: 'createMcpServer',
    summary:
      'Connect a remote MCP server (Streamable HTTP); its host joins the brand’s egress allowlist (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    body: CreateMcpServerRequest,
    idempotent: true,
    success: { status: 201, description: 'Server connected', schema: McpServer },
  },
  updateMcpServer: {
    method: 'patch',
    path: '/v1/admin/mcp-servers/{serverId}',
    operationId: 'updateMcpServer',
    summary: 'Rename, disable or change the token of an MCP server (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: serverParams,
    body: UpdateMcpServerRequest,
    success: { status: 200, description: 'Server', schema: McpServer },
  },
  syncMcpServer: {
    method: 'post',
    path: '/v1/admin/mcp-servers/{serverId}/sync',
    operationId: 'syncMcpServer',
    summary:
      'List the server’s tools; new or changed tools wait for review before any agent can use them (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: serverParams,
    success: { status: 200, description: 'Tools listed', schema: McpSyncResult },
  },
  getActionSettings: {
    method: 'get',
    path: '/v1/admin/action-settings',
    operationId: 'getActionSettings',
    summary: 'Autopilot switch and the tenant’s daily autopilot budget (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    success: { status: 200, description: 'Settings', schema: ActionSettings },
  },
  updateActionSettings: {
    method: 'put',
    path: '/v1/admin/action-settings',
    operationId: 'updateActionSettings',
    summary: 'Turn autopilot on or off and set its daily budget (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    body: UpdateActionSettingsRequest,
    success: { status: 200, description: 'Settings', schema: ActionSettings },
  },
  listActions: {
    method: 'get',
    path: '/v1/admin/actions',
    operationId: 'listActions',
    summary: 'AI actions, newest first: what was proposed, decided and done (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    query: z.object({
      conversationId: z.string().optional(),
      toolId: z.string().optional(),
      state: ActionState.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: Cursor.optional(),
    }),
    success: { status: 200, description: 'Actions', schema: page(Action) },
  },
  cancelRun: {
    method: 'post',
    path: '/v1/admin/runs/{runId}/cancel',
    operationId: 'cancelRun',
    summary:
      'Stop a running AI run: tool calls in flight are cancelled, changes already sent are reconciled (conversations.takeover)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: z.object({ runId: z.string().meta({ description: 'Run ID (run_…)' }) }),
    success: { status: 200, description: 'Cancellation requested', schema: Run },
  },
  listSimulationSuites: {
    method: 'get',
    path: '/v1/admin/agents/{agentId}/simulations',
    operationId: 'listSimulationSuites',
    summary: 'Simulation suites of an agent (agents.read)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: agentParams,
    success: {
      status: 200,
      description: 'Suites',
      schema: z.object({ items: z.array(SimulationSuite) }),
    },
  },
  createSimulationSuite: {
    method: 'post',
    path: '/v1/admin/agents/{agentId}/simulations',
    operationId: 'createSimulationSuite',
    summary: 'Save canned conversations with fake tool answers (agents.manage)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: agentParams,
    body: SaveSimulationSuiteRequest,
    success: { status: 201, description: 'Suite saved', schema: SimulationSuite },
  },
  updateSimulationSuite: {
    method: 'put',
    path: '/v1/admin/agents/{agentId}/simulations/{suiteId}',
    operationId: 'updateSimulationSuite',
    summary: 'Replace a suite’s cases (agents.manage)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: suiteParams,
    body: SaveSimulationSuiteRequest,
    success: { status: 200, description: 'Suite saved', schema: SimulationSuite },
  },
  deleteSimulationSuite: {
    method: 'delete',
    path: '/v1/admin/agents/{agentId}/simulations/{suiteId}',
    operationId: 'deleteSimulationSuite',
    summary: 'Delete a suite and its runs (agents.manage)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: suiteParams,
    success: { status: 204, description: 'Deleted' },
  },
  runSimulation: {
    method: 'post',
    path: '/v1/admin/agents/{agentId}/simulations/{suiteId}/runs',
    operationId: 'runSimulation',
    summary:
      'Replay the suite against the draft and the published version with the mock model and fake tools; nothing is sent or executed (agents.manage)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: suiteParams,
    success: { status: 201, description: 'Simulation run', schema: SimulationRun },
  },
  listSimulationRuns: {
    method: 'get',
    path: '/v1/admin/agents/{agentId}/simulations/{suiteId}/runs',
    operationId: 'listSimulationRuns',
    summary: 'Recent runs of a suite, newest first (agents.read)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: suiteParams,
    success: {
      status: 200,
      description: 'Runs',
      schema: z.object({ items: z.array(SimulationRun) }),
    },
  },
} as const satisfies Record<string, RouteDef>;

/** Staff inbox: the actions, approvals and handoff packets of one conversation. */
export const actionInboxRoutes = {
  listConversationActions: {
    method: 'get',
    path: '/v1/inbox/conversations/{conversationId}/actions',
    operationId: 'listConversationActions',
    summary: 'AI actions in the conversation with their approval and receipt (conversations.read)',
    tags: ['Inbox'],
    auth: 'staff_session',
    params: conversationParams,
    success: {
      status: 200,
      description: 'Actions',
      schema: z.object({ items: z.array(Action) }),
    },
  },
  decideConversationAction: {
    method: 'post',
    path: '/v1/inbox/conversations/{conversationId}/actions/{actionId}/decision',
    operationId: 'decideConversationAction',
    summary:
      'Approve or decline an AI action that staff approve; money and irreversible actions need a fresh sign-in (tools.approve and the tool’s own permission)',
    tags: ['Inbox'],
    auth: 'staff_session',
    params: actionParams,
    body: DecideActionRequest,
    success: { status: 200, description: 'Decision recorded', schema: Action },
  },
  checkConversationAction: {
    method: 'post',
    path: '/v1/inbox/conversations/{conversationId}/actions/{actionId}/check',
    operationId: 'checkConversationAction',
    summary:
      'Check an action whose outcome is not confirmed with the tool; never sends it again (tools.approve)',
    tags: ['Inbox'],
    auth: 'staff_session',
    params: actionParams,
    success: { status: 200, description: 'Action', schema: Action },
  },
  listHandoffPackets: {
    method: 'get',
    path: '/v1/inbox/conversations/{conversationId}/handoff-packets',
    operationId: 'listHandoffPackets',
    summary:
      'What the AI handed over, newest first: why, what it tried, what is pending (conversations.read)',
    tags: ['Inbox'],
    auth: 'staff_session',
    params: conversationParams,
    success: {
      status: 200,
      description: 'Packets',
      schema: z.object({ items: z.array(HandoffPacket) }),
    },
  },
} as const satisfies Record<string, RouteDef>;

/** Customer: approval cards in the widget (W16). */
export const actionWidgetRoutes = {
  getWidgetAction: {
    method: 'get',
    path: '/v1/widget/conversations/{conversationId}/actions/{actionId}',
    operationId: 'getWidgetAction',
    summary: 'An AI action in this conversation, as the customer may see it',
    tags: ['Widget'],
    auth: 'widget_session',
    params: actionParams,
    success: { status: 200, description: 'Action', schema: Action },
  },
  decideWidgetAction: {
    method: 'post',
    path: '/v1/widget/conversations/{conversationId}/actions/{actionId}/decision',
    operationId: 'decideWidgetAction',
    summary:
      'Approve or decline your own request exactly as shown; staff-only actions cannot be approved here',
    tags: ['Widget'],
    auth: 'widget_session',
    params: actionParams,
    body: DecideActionRequest,
    success: { status: 200, description: 'Decision recorded', schema: Action },
  },
} as const satisfies Record<string, RouteDef>;
