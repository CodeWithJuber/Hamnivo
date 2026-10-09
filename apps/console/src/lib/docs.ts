/**
 * Where the written guides are. Studio links to them; they open in a new tab. In a deployment they
 * are pages of the docs site the edge serves at /docs/ on the website's host (VITE_HAMNIVO_DOCS_URL,
 * set at build time). Without it (development), the address is the file's page on GitHub.
 */
const SITE = import.meta.env.VITE_HAMNIVO_DOCS_URL?.replace(/\/$/, '');
const GITHUB = 'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs';

/** A guide in `docs/guide/<area>/<slug>.md`, as a page of the docs site when there is one. */
const guide = (area: string, slug: string) =>
  SITE ? `${SITE}/${area}/${slug}/` : `${GITHUB}/guide/${area}/${slug}.md`;

export const DOCS = {
  /** Customer identity keys, for a developer. */
  identity: `${GITHUB}/guides/identity.md`,
  /** The setup guides for people who are not developers. */
  setup: {
    gettingStarted: guide('setup', 'getting-started'),
    aiKeys: guide('setup', 'ai-keys'),
    widgetLook: guide('setup', 'widget-look'),
    testChat: guide('setup', 'test-chat'),
    businessHours: guide('setup', 'business-hours'),
    /** The pre-chat form and the contact form for when nobody can answer. */
    chatWidgetForms: guide('setup', 'chat-widget-forms'),
    /** Asking customers to agree before they chat. */
    consent: guide('setup', 'consent'),
    /** The page with only the chat on it, and its QR code. */
    directLink: guide('setup', 'direct-link'),
    /** Email, WhatsApp and Telegram in the same inbox (ADR 0013). */
    channels: guide('setup', 'channels'),
  },
  /** Rules that act on their own: website prompts and chat automations. */
  automation: {
    automations: guide('automation', 'automations'),
  },
  /** The guides for people working in the inbox. */
  inbox: {
    tickets: guide('inbox', 'tickets'),
    /** Blocking a visitor who misuses the chat, and unblocking them. */
    blockingVisitors: guide('inbox', 'blocking-visitors'),
  },
  /** An installation guide for one website platform, by its file name without `.md`. */
  integration: (slug: string) => guide('integrations', slug),
} as const;
