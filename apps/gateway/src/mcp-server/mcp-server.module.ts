import { McpData } from './mcp-data.service.js';
import { McpRateLimiter } from './mcp-rate-limit.js';
import { McpServerController } from './mcp-server.controller.js';
import { McpServerService } from './mcp-server.service.js';

/**
 * Hamnivo's own MCP server (API process only): `/mcp`, read-only tools for AI assistants, called
 * with an API key. It reads through the services the inbox, knowledge and memory already use.
 */
export const MCP_SERVER_API_CONTROLLERS = [McpServerController];

export const MCP_SERVER_API_PROVIDERS = [McpData, McpRateLimiter, McpServerService];
