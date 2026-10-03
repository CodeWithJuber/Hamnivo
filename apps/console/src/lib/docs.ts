/**
 * Where the written guides are. Studio links to them; they open in a new tab. The guides are
 * plain Markdown in the repository, so the address is the file's page on GitHub.
 */
const BASE = 'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs';

export const DOCS = {
  /** Customer identity keys, for a developer. */
  identity: `${BASE}/guides/identity.md`,
  /** The setup guides for people who are not developers. */
  setup: {
    gettingStarted: `${BASE}/guide/setup/getting-started.md`,
    aiKeys: `${BASE}/guide/setup/ai-keys.md`,
    widgetLook: `${BASE}/guide/setup/widget-look.md`,
    testChat: `${BASE}/guide/setup/test-chat.md`,
    businessHours: `${BASE}/guide/setup/business-hours.md`,
  },
  /** An installation guide for one website platform, by its file name without `.md`. */
  integration: (slug: string) => `${BASE}/guide/integrations/${slug}.md`,
} as const;
