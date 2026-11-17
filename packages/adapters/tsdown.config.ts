import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'a2a/index': 'src/a2a/index.ts',
    'whmcs/index': 'src/whmcs/index.ts',
    'stores/index': 'src/stores/index.ts',

    'models/index': 'src/models/index.ts',
    'jev/index': 'src/jev/index.ts',
    'cache/index': 'src/cache/index.ts',
    'commerce/index': 'src/commerce/index.ts',
    'commerce/testing': 'src/commerce/testing.ts',
    'net/index': 'src/net/index.ts',
    'billing/index': 'src/billing/index.ts',
    'billing/testing': 'src/billing/testing.ts',
    'mcp/index': 'src/mcp/index.ts',
    'mcp/testing': 'src/mcp/testing.ts',
    'tools/index': 'src/tools/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'neutral',
  // The commerce mock, the fake Stripe and MCP servers, the egress guard (net) and the MCP client
  // run in Node only (tests, the API and the worker).
  external: [/^node:/, /^@modelcontextprotocol\/sdk/],
});
