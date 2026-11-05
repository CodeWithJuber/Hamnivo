/**
 * Studio: Settings → Privacy (A10): how long conversations are kept, and one customer's data on
 * request. Merged under `privacy`.
 */
export const privacyEn = {
  nav: 'Privacy',
  title: 'Privacy',
  description:
    'How long your workspace keeps conversations, and what you can do when a customer asks for their data or to be erased.',
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
  customers: {
    title: 'A customer’s data',
    description:
      'Find a customer to download everything about them, or to erase them everywhere, Chatwoot included.',
    guide: 'Downloading and erasing',
    search: 'Find a customer',
    searchHint:
      'Name, email address, phone number, their ID in your own systems, or a customer or conversation ID. At least 2 characters.',
    find: 'Find',
    searching: 'Looking for customers',
    none: 'No customer matches “{{query}}”.',
    results: 'Customers found',
    unnamed: 'Visitor without a name',
    erased: 'Erased',
    lastSeen: 'Last seen {{date}}',
    loading: 'Loading the customer',
    id: 'Customer ID',
    brand: 'Brand',
    conversations: 'Conversations',
    orders: 'Orders',
    memories: 'Memories',
    shared:
      'Their Chatwoot contact also has conversations of another brand. Those conversations, and the contact, stay.',
    ordersKept: 'Their orders stay as business records, without their name or delivery details.',
    erasedNote:
      'This customer was erased. Only an anonymous record is left, because their orders point at it.',
    close: 'Close',
    download: 'Download their data',
    erase: 'Erase this customer',
    exportStarted: 'Preparing the file. It appears under Requests when it is ready.',
    eraseStarted: 'Erasing has started. It appears under Requests when it is done.',
    reason: {
      label: 'Why',
      access_request: 'They asked for their data',
      erasure_request: 'They asked to be erased',
      other: 'Another reason',
    },
    reference: 'Reference (optional)',
    referenceHint: 'Your ticket or case number. Keep personal details out of it.',
    exportTitle: 'Download {{name}}’s data',
    exportBody:
      'The file holds their profile, their conversations as they saw them, the files sent both ways, consents, memory, orders and feedback. Internal notes are left out. You can download it for 24 hours, and each download is recorded.',
    exportSubmit: 'Prepare the file',
    eraseTitle: 'Erase {{name}}',
    eraseBody:
      'This deletes their conversations and contact in Chatwoot, and everything about them in Hamnivo: profile, conversations, files, memory, feedback and preferences. It cannot be undone.',
    eraseKept:
      'Kept: orders and payments without their name or delivery details, consent records and the audit log.',
    confirm: 'Type the customer ID to confirm: {{id}}',
    confirmMismatch: 'Type the customer ID exactly as shown.',
    eraseSubmit: 'Erase everywhere',
  },
  requests: {
    title: 'Requests',
    description: 'Exports and erasures, newest first.',
    loading: 'Loading requests',
    empty: 'No exports or erasures yet.',
    kind: { export: 'Export', erase: 'Erasure' },
    state: {
      queued: 'Waiting',
      running: 'Working',
      completed: 'Done',
      blocked: 'Stopped',
      failed: 'Failed',
    },
    by: 'By {{name}}',
    download: 'Download',
    until: 'Until {{date}}',
    gone: 'Deleted after 24 hours',
    exported: 'Conversations: {{conversations}} · Files: {{files}}',
    erasedCounts:
      'Conversations deleted: {{conversations}} · Chatwoot contacts deleted: {{contacts}}',
    blocked:
      'Chatwoot did not let Hamnivo delete. The Chatwoot user Hamnivo connects with must be an administrator. Nothing was deleted in Hamnivo. Ask again once that is fixed.',
    failed: 'It did not finish. Ask again.',
  },
} as const;
