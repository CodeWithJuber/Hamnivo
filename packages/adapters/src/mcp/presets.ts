/**
 * Remote MCP servers that vendors run themselves, for Studio's "Connect a service" list. Only
 * servers whose own documentation names the address are here; each entry says which page, and
 * when it was read. A preset only fills in the form: connecting still goes through the same
 * checks as any address (public HTTPS, the workspace's allowed hosts) and every tool the server
 * lists still waits for a person to review it.
 *
 * Left out, because their own documentation did not settle it on 2026-10-03: HubSpot (its page
 * gives the host without a scheme and needs an app in a developer account), Zendesk (its
 * documentation covers connecting Zendesk to other servers, not its own), Help Scout (no vendor
 * server), Wix (its API key goes in headers Hamnivo does not send). Left out because the vendor
 * lets only approved clients connect, so Hamnivo could not: Slack, Square, Vercel. Left out
 * because the credential expires within hours: PayPal. Left out because it is retired for a new
 * protocol: Shopify's storefront server.
 */

/**
 * How the service signs a client in. `oauth`: a browser sign-in. `token`: a token the person
 * creates in the service and pastes. `oauth_or_token`: either.
 */
export type McpPresetAuth = 'oauth' | 'oauth_or_token' | 'token';

export type McpPresetCategory = 'support' | 'commerce' | 'work' | 'engineering';

export interface McpPreset {
  /** Stable key; Studio looks the translated summary and note up by it. */
  id: string;
  /** The product's name as its vendor writes it. */
  name: string;
  vendor: string;
  /** The vendor's own Streamable HTTP address. */
  url: string;
  /** The vendor's page that names the address. */
  docsUrl: string;
  category: McpPresetCategory;
  auth: McpPresetAuth;
  /** What it is for, in one plain English sentence (Studio shows its own translation when it has one). */
  summary: string;
  /** A hint for the one thing people trip over, when there is one (translated the same way). */
  note?: string;
  /** The day the vendor's page was read. */
  verifiedOn: string;
}

const VERIFIED = '2026-10-03';

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'intercom-us',
    name: 'Intercom (US)',
    vendor: 'Intercom',
    url: 'https://mcp.intercom.com/mcp',
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    category: 'support',
    auth: 'oauth_or_token',
    summary: 'Look up conversations, contacts and help center articles in Intercom.',
    note: 'Use this one when your Intercom workspace is hosted in the US.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'intercom-eu',
    name: 'Intercom (EU)',
    vendor: 'Intercom',
    url: 'https://mcp.eu.intercom.com/mcp',
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    category: 'support',
    auth: 'oauth_or_token',
    summary: 'Look up conversations, contacts and help center articles in Intercom.',
    note: 'Use this one when your Intercom workspace is hosted in the EU.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'gorgias',
    name: 'Gorgias',
    vendor: 'Gorgias',
    url: 'https://mcp.gorgias.com/mcp',
    docsUrl: 'https://docs.gorgias.com/en-US/connect-your-ai-assistant-to-gorgias-6310546',
    category: 'support',
    auth: 'oauth',
    summary: 'Read tickets and customers in your Gorgias help desk.',
    note: 'Gorgias asks for your account name when you sign in.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    url: 'https://mcp.stripe.com',
    docsUrl: 'https://docs.stripe.com/mcp',
    category: 'commerce',
    auth: 'oauth_or_token',
    summary: 'Look up customers, payments, subscriptions and refunds in Stripe.',
    note: 'Sign in with OAuth, or paste a Stripe agent API key as the token.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'klaviyo',
    name: 'Klaviyo',
    vendor: 'Klaviyo',
    url: 'https://mcp.klaviyo.com/mcp',
    docsUrl: 'https://developers.klaviyo.com/en/docs/connect_to_the_klaviyo_mcp_server',
    category: 'commerce',
    auth: 'oauth',
    summary: 'Read customer profiles, lists and campaign results in Klaviyo.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'calendly',
    name: 'Calendly',
    vendor: 'Calendly',
    url: 'https://mcp.calendly.com',
    docsUrl: 'https://developer.calendly.com/calendly-mcp-server',
    category: 'work',
    auth: 'oauth',
    summary: 'Check availability and scheduled events in Calendly.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    docsUrl: 'https://linear.app/docs/mcp',
    category: 'work',
    auth: 'oauth_or_token',
    summary: 'Find and read issues and projects in Linear.',
    note: 'Linear also has a read-only address, https://mcp.linear.app/mcp/readonly.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'notion',
    name: 'Notion',
    vendor: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
    category: 'work',
    auth: 'oauth',
    summary: 'Search and read pages and databases in Notion.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira and Confluence)',
    vendor: 'Atlassian',
    url: 'https://mcp.atlassian.com/v2/mcp',
    docsUrl:
      'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    category: 'work',
    auth: 'oauth',
    summary: 'Find and read Jira issues and Confluence pages.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'asana',
    name: 'Asana',
    vendor: 'Asana',
    url: 'https://mcp.asana.com/v2/mcp',
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server',
    category: 'work',
    auth: 'oauth',
    summary: 'Find and read tasks and projects in Asana.',
    note: 'If Asana asks for a client ID, create an app in Asana’s developer console and enter it.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'monday',
    name: 'monday.com',
    vendor: 'monday.com',
    url: 'https://mcp.monday.com/mcp',
    docsUrl: 'https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp',
    category: 'work',
    auth: 'oauth_or_token',
    summary: 'Find and read boards and items in monday.com.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    docsUrl: 'https://mcp.sentry.dev/',
    category: 'engineering',
    auth: 'oauth',
    summary: 'Look up errors and issues in Sentry.',
    verifiedOn: VERIFIED,
  },
  {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    docsUrl: 'https://github.com/github/github-mcp-server',
    category: 'engineering',
    auth: 'token',
    summary: 'Search and read repositories, issues and pull requests on GitHub.',
    note: 'Create a personal access token on GitHub and paste it as the token.',
    verifiedOn: VERIFIED,
  },
];
