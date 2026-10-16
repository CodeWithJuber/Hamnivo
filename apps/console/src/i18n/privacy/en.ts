/** Studio: Settings → Privacy, how long conversations are kept (A10). Merged under `privacy`. */
export const privacyEn = {
  nav: 'Privacy',
  title: 'Privacy',
  description: 'How long your workspace keeps conversations, and what is deleted after that.',
  retention: {
    title: 'How long conversations are kept',
    description:
      'Resolved conversations whose last message is older than this are deleted in Chatwoot and in Hamnivo, with their files. Customers left with no conversation are removed too. Reports keep their numbers.',
    guide: 'How retention works',
    loading: 'Loading how long conversations are kept',
    label: 'Keep resolved conversations',
    hint: 'Counted from the last message. A conversation the customer writes in again is kept.',
    forever: 'Until they are deleted by hand',
    periods: {
      d90: '3 months',
      d180: '6 months',
      d365: '1 year',
      d730: '2 years',
      d1095: '3 years',
      d1825: '5 years',
      d2555: '7 years',
    },
    counting: 'Counting conversations…',
    preview: 'Resolved conversations older than this today: {{n}}.',
    startsOn:
      'Deleting starts on {{date}}, a week after you save, so it can still be undone. Every owner gets an email about it.',
    atOnce: 'This deletes nothing sooner, so it applies at once.',
    save: 'Save',
    saved: 'Saved.',
    pending:
      'From {{date}}, resolved conversations older than {{period}} will be deleted. Until then you can undo it.',
    undo: 'Undo',
    undone: 'Undone. Nothing more will be deleted than before.',
    progress: 'Deleted so far: {{conversations}} conversations and {{customers}} customers.',
    checked: 'Last checked {{date}}.',
    running: 'Deleting old conversations. The first time can take a while.',
    blocked:
      'Deleting has stopped: Chatwoot did not let Hamnivo delete conversations. The Chatwoot user Hamnivo connects with must be an administrator. Nothing was deleted in Hamnivo either. Deleting starts again by itself once that is fixed.',
    kept: 'Orders, payments and the audit log are kept: they are business records.',
  },
} as const;
