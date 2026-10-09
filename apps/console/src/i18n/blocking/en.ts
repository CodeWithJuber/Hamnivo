/**
 * Studio: blocking visitors who misuse the chat (H20), from a chat, from Live visitors and on the
 * Blocked page. The visitor is never told they were blocked; only that chat isn't available.
 */
export const blockingEn = {
  menuItem: 'Block visitor…',
  action: 'Block',
  actionFor: 'Block {{name}}',
  dialog: {
    title: 'Block {{name}}',
    explanation:
      'They will see that chat isn’t available. Clearing their browser gets around a block; signed-in customers stay blocked on any device.',
    reason: 'Reason',
    reasonHint: 'Only your team sees this, on the Blocked page.',
    reasonMissing: 'Write why you are blocking them.',
    duration: 'How long',
    closeChat: 'Also close this chat',
    submit: 'Block visitor',
    done: '{{name}} is blocked.',
    doneClosed: '{{name}} is blocked, and the chat is closed.',
  },
  durations: {
    day: '24 hours',
    week: '7 days',
    month: '30 days',
    always: 'Until unblocked',
  },
  durationHints: {
    until: 'Until {{time}}',
    never: 'Until someone on your team unblocks them',
  },
  page: {
    link: 'Blocked',
    /** An anonymous visitor, by the short code that tells them apart. */
    anonymous: 'Visitor {{code}}',
    title: 'Blocked visitors',
    description:
      'Visitors who can’t chat with your brands, why they were blocked and until when. Unblock someone here and they can chat again at once.',
    guide: 'How blocking works',
    back: 'Back to the inbox',
    loading: 'Loading blocked visitors',
    table: 'Blocked visitors, newest first',
    show: 'Show',
    filters: {
      active: 'Active',
      all: 'All (last 90 days)',
    },
    brand: 'Brand',
    allBrands: 'All brands',
    columns: {
      who: 'Who',
      reason: 'Reason',
      by: 'Blocked by',
      when: 'When',
      expires: 'Expires',
      actions: 'Actions',
    },
    signedIn: 'Signed in',
    formerStaff: 'Someone no longer on the team',
    standing: {
      never: 'Until unblocked',
      lifted: 'Unblocked {{time}}',
      liftedBy: 'Unblocked by {{name}}, {{time}}',
      expired: 'Ended {{time}}',
    },
    openChat: 'Open chat',
    openChatFor: 'Open the chat with {{name}}',
    unblock: 'Unblock',
    unblockFor: 'Unblock {{name}}',
    confirm: {
      title: 'Unblock {{name}}?',
      body: 'They can start chatting again right away. The block stays listed here, marked as unblocked.',
      submit: 'Unblock',
      done: '{{name}} is unblocked.',
      failed: '{{name}} is still blocked.',
    },
    empty: {
      title: 'Nobody is blocked',
      description:
        'When someone misuses the chat, block them from the chat’s More actions menu or from Live visitors.',
      allTitle: 'No blocks in the last 90 days',
    },
    forbidden: {
      title: 'You can’t see blocked visitors',
      description: 'Your role can’t block or unblock visitors. Ask an admin or a supervisor.',
    },
  },
} as const;
