/**
 * Studio text for what staff hear and see in the inbox, in English, the source language: sound and
 * desktop alerts, unread chats, online/away/offline and typing. Kept apart from the main file so it
 * can grow on its own; merged under `inboxAlerts`.
 */
export const inboxAlertsEn = {
  status: {
    label: 'Your status',
    online: 'Online',
    away: 'Away',
    offline: 'Offline',
    hint: 'Customers are told a person is online only while someone who can answer is online.',
    idle: 'Your team sees you as away: Studio has not been used for a few minutes.',
    changed: 'Your status is now {{status}}.',
    teammate: '{{name}}, {{status}}',
  },
  settings: {
    button: 'Alerts',
    title: 'Sounds and desktop alerts',
    description: 'These settings are only yours. Each teammate keeps their own.',
    mute: 'Mute all sounds',
    muteHint: 'Desktop alerts and the count on the browser tab still work.',
    volume: 'Volume',
    volumeValue: '{{value}} percent',
    silent: 'No sound will play while sounds are muted or the volume is at 0.',
    events: {
      title: 'Sound for each event',
      newChat: 'A chat is waiting for a person',
      customerMessage: 'A customer writes in your chat, or in a chat nobody has taken',
      assigned: 'A chat is assigned or transferred to you',
    },
    sounds: {
      chime: 'Chime',
      pop: 'Pop',
      bell: 'Bell',
      drop: 'Drop',
      ping: 'Ping',
      none: 'No sound',
    },
    play: 'Play {{sound}}',
    blocked: 'Your browser kept the sound silent. Click anywhere on the page once, then try again.',
    saveFailed: 'Your last change could not be saved. The settings show what is saved.',
    desktop: {
      title: 'Desktop alerts',
      enabled: 'Show a desktop alert when Studio is in the background',
      enabledHint: 'You get one for each new chat, message or assignment while you are elsewhere.',
      preview: 'Show the start of the customer’s message',
      previewHint: 'Turn this off if other people can see your screen.',
      unsupported: 'This browser cannot show desktop alerts.',
      prompt: 'Your browser will ask for permission. Choose Allow.',
      allow: 'Allow desktop alerts',
      granted: 'Desktop alerts are allowed in this browser.',
      denied:
        'Desktop alerts are blocked in this browser. To turn them on, allow notifications for this site in your browser settings, then reload this page.',
      test: 'Send a test alert',
      testTitle: 'Hamnivo test alert',
      testBody: 'This is how a desktop alert looks. Click it to come back to Studio.',
    },
  },
  banner: {
    title: 'Hear about new chats while Studio is in the background',
    description:
      'Allow desktop alerts to be told about new chats and messages while you work in another tab or window.',
    allow: 'Allow desktop alerts',
    later: 'Not now',
  },
  alert: {
    chat_waiting: '{{name}} is waiting for a person',
    customer_message: 'New message from {{name}}',
    assigned: 'A chat was assigned to you',
    assignedBody: '{{name}}: {{preview}}',
    open: 'Open the chat to read it.',
  },
  unread: {
    row: 'Unread messages: {{count}}',
  },
  typing: {
    customer: '{{name}} is typing…',
  },
  visitor: {
    title: 'Website visit',
    notNoted: 'This brand does not note which pages visitors view.',
    none: 'No pages are noted for this customer. They may use Do Not Track, or the chat was opened where the website’s chat script does not run.',
    online: 'On the website now',
    left: 'Left the website {{when}}',
    currentPage: 'Current page',
    entryPage: 'Entered on',
    visits: 'Visits',
    visitor: 'Visitor',
    returning: 'Returning',
    new: 'New',
    timeOnSite: 'Time on site',
    underMinute: 'Less than a minute',
    country: 'Country',
    device: 'Device',
    language: 'Language',
    cameFrom: 'Came from',
    pages: 'Pages in this visit',
    untitled: 'Untitled page',
    openPage: 'Open {{page}} in a new tab',
    types: { desktop: 'Computer', mobile: 'Phone', tablet: 'Tablet', other: 'Device' },
    privacy: 'Pages are noted without query strings and kept for 30 days. No IP address is stored.',
  },
} as const;

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English keys; TypeScript reports a missing one. */
export type InboxAlertsTranslation = Strings<typeof inboxAlertsEn>;
