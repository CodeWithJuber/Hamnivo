/**
 * Studio: the Channels page (Settings): web chat, and the email, WhatsApp and Telegram inboxes of
 * a brand's Chatwoot account, with whether the AI answers there, their team, and pausing them.
 */
export const channelsEn = {
  nav: 'Channels',
  title: 'Channels',
  description: 'Answer email, WhatsApp and Telegram from the same inbox as your web chat.',
  loading: 'Loading channels',
  guide: 'How channels work',
  brand: 'Brand',
  list: 'Channels of {{brand}}',
  forbidden: {
    title: 'You can’t manage channels',
    description: 'Ask a workspace owner or administrator for a role that may manage integrations.',
  },
  noBrands: {
    title: 'No brand yet',
    description: 'Add a brand first. Then connect its channels here.',
    action: 'Go to Brands and install',
  },
  kind: {
    web: 'Web chat',
    email: 'Email',
    whatsapp: 'WhatsApp',
    telegram: 'Telegram',
    other: 'Other',
  },
  status: {
    connected: 'Connected',
    needs_attention: 'Needs attention',
    paused: 'Paused',
  },
  problem: 'Chatwoot says: {{problem}}',
  web: {
    text: 'Your website’s chat widget.',
    link: 'Chat widget settings',
  },
  conversations_one: '{{count}} conversation this week',
  conversations_other: '{{count}} conversations this week',
  lastMessage: 'Last message: {{time}}',
  noMessages: 'No messages yet',
  ai: {
    label: 'AI answers here',
    hint: 'Off: your team answers every conversation. On: the AI answers first and hands over to your team when needed.',
    on: 'The AI now answers first on {{name}}.',
    off: 'Your team now answers every conversation on {{name}}.',
  },
  team: {
    label: 'Team',
    none: 'No team (use routing)',
    hidden: 'A team you can’t see',
    saved: 'New conversations on {{name}} now go to {{team}}.',
    cleared: 'Routing now decides who gets new conversations on {{name}}.',
  },
  pause: {
    action: 'Pause',
    label: 'Pause {{name}}',
    title: 'Pause {{name}}?',
    body: 'New conversations on this channel stay in Chatwoot until you resume. Conversations already here carry on.',
    confirm: 'Pause channel',
    done: '{{name}} is paused.',
  },
  resume: {
    action: 'Resume',
    label: 'Resume {{name}}',
    done: '{{name}} is running again.',
  },
  unclaimed: {
    text: 'Found in your Chatwoot account.',
    action: 'Use for this brand',
    done: '{{name}} now answers for {{brand}}.',
  },
  empty: {
    title: 'No email, WhatsApp or Telegram channels yet.',
    description:
      'Add one in Chatwoot (Settings → Inboxes), then check again here. Connecting them from Studio is coming next.',
  },
  check: {
    action: 'Check for new channels',
    busy: 'Checking…',
    found_one: 'Found {{count}} new channel',
    found_other: 'Found {{count}} new channels',
    none: 'No new channels',
  },
  chatwoot: {
    title: 'Chatwoot didn’t answer',
    description: 'Try again in a moment.',
  },
};
