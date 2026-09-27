import type { Dictionary } from './types';

export const en: Dictionary = {
  meta: {
    title: 'Hamnivo: open-source customer chat for people and AI',
    description:
      'Hamnivo is an open-source customer conversation platform you host yourself. Customers, your staff and AI agents share one conversation.',
    ogImageAlt: 'The Hamnivo logo on an ivory background.',
  },
  a11y: {
    skipLink: 'Skip to main content',
    languageNav: 'Language',
  },
  nav: { github: 'GitHub' },
  hero: {
    eyebrow: 'Open source · MIT License · Self-hosted',
    title: 'Customer chat where people and AI work together',
    lead: 'Hamnivo is an open-source customer conversation platform. Add it to your website with one script, or build your own interface on its API. Customers, your staff and AI agents share one conversation, on servers you run.',
    primaryCta: 'Self-host from GitHub',
    secondaryCta: 'See it working',
    status:
      'Hamnivo is in active development. Features that are not ready yet are marked “Coming”.',
    statusLink: 'See what works today',
  },
  coming: 'Coming',
  features: {
    teamwork: {
      eyebrow: 'Teamwork',
      title: 'People and AI, one conversation',
      lead: 'Customers, your staff and AI agents talk in the same conversation. The AI can answer first, and someone from your team can step in at any moment.',
      points: [
        'A customer can ask for a person at any time. Your team gets a private handoff note, so the customer does not have to repeat themselves.',
        'Staff reply from the Chatwoot inbox that Hamnivo connects to. When a person takes over, the AI stops, and replies it was still writing are not sent.',
        'Every message shows who wrote it: the AI assistant or a support agent. The AI never pretends to be human.',
        'Connecting the AI model you choose. For now, AI replies come from a built-in test model.',
        'A Hamnivo workspace for your team, with private notes and specialist AI agents you can invite.',
      ],
    },
    memory: {
      eyebrow: 'Memory',
      title: 'Memory with consent',
      lead: 'Hamnivo will remember details that help, such as a customer’s preferred language, only where you allow it. People will be able to see what it remembers, correct it and delete it.',
      points: [
        'You set the scope: one conversation, one customer or one team.',
        'Each remembered detail keeps its source and date. A correction replaces the old fact.',
        'Learning from past conversations needs separate consent.',
      ],
    },
    developers: {
      eyebrow: 'Developers',
      title: 'Built for developers',
      lead: 'Hamnivo is API-first. The chat widget, the SDK and your own code all use the same public API.',
      points: [
        'One script tag adds the chat to your website. The chat itself loads only when a visitor opens it.',
        'A REST API described in OpenAPI 3.1, with an interactive reference on your own server.',
        'A JavaScript and TypeScript SDK for building your own chat interface.',
        'Live updates that carry on after a dropped connection.',
        'Webhooks, so your own systems can react to conversations.',
      ],
    },
    languages: {
      eyebrow: 'Languages',
      title: 'Every language your customers use',
      lead: 'People write in the language they think in, and many mix two. Hamnivo is built for that from the start.',
      points: [
        'The chat widget works in English, Arabic, Hindi and Urdu.',
        'Arabic and Urdu read right to left, while order numbers and codes keep their own direction.',
        'Understanding Hinglish and Roman Urdu, the way people really type them.',
        'A translation next to each original message, for customers and staff.',
      ],
      note: 'Native speakers have not yet reviewed the widget’s Arabic, Hindi and Urdu text.',
    },
    commerce: {
      eyebrow: 'Commerce',
      title: 'Checkout inside the chat',
      lead: 'Customers will be able to choose a product, check the total and pay without leaving the conversation.',
      points: [
        'Nothing is bought until the customer confirms it.',
        'Staff approve exceptions, such as a refund outside your policy.',
        'Prices and totals come from your store, not from the AI.',
        'An order counts as paid only after your payment provider confirms it.',
      ],
    },
  },
  demo: {
    eyebrow: 'Demo',
    title: 'See it working',
    liveBody:
      'The chat button in the corner of this page is a live Hamnivo widget. Open it and send a message. Each reply shows whether the AI or a person wrote it.',
    openChat: 'Open the chat',
    liveCode: 'This is all the code the page needed:',
    offlineBody:
      'This copy of the site is not connected to a live chat. Run Hamnivo yourself with the steps below, then add this script to any web page.',
    offlineHint: 'Use your own widget ID and the addresses of your chat and API servers.',
    guideLink: 'How to put the chat on a web page',
  },
  selfHost: {
    eyebrow: 'Self-hosting',
    title: 'Self-host it',
    lead: 'Hamnivo runs on your own server. These four steps start it on one machine for development and testing.',
    steps: [
      {
        title: 'Prepare a server',
        body: 'Use Linux with Docker, Node.js 24 and pnpm 10. For development, plan for 2 CPU cores, 6 GB of memory and 25 GB of disk.',
      },
      {
        title: 'Get the code',
        body: 'Clone the repository and install its dependencies.',
      },
      {
        title: 'Create your secrets',
        body: 'This writes `.env.local` with generated passwords and keys. Keep the file private and back it up.',
      },
      {
        title: 'Start the services',
        body: 'Start the database, Chatwoot and the API. Then run `pnpm worker` in a second terminal.',
      },
    ],
    guideLink: 'Read the full self-hosting guide',
    note: 'A production setup with automatic HTTPS is coming.',
  },
  code: {
    html: 'HTML',
    terminal: 'Terminal',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Could not copy. Select the code and copy it.',
  },
  footer: {
    tagline: 'Conversations, people and agents in one place.',
    about: 'Hamnivo is open source under the MIT License.',
    projectHeading: 'Project',
    source: 'Source code on GitHub',
    guide: 'Self-hosting guide',
    status: 'What works today',
    docs: 'Documentation',
    license: 'MIT License',
  },
  widget: { label: 'Open chat', closeLabel: 'Close chat', title: 'Chat' },
};
