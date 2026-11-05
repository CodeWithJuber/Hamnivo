/**
 * Studio inbox: AI drafts awaiting review (HNV-09-05). In assist mode the AI writes a reply to each
 * customer message from public knowledge; a person approves, edits or rejects it. Merged under
 * `inbox.aiDrafts`.
 */
export const aiDraftsEn = {
  title: 'AI draft for review',
  by: 'Written by {{name}} (AI) from public sources. Nothing is sent until you approve it.',
  textLabel: 'Draft reply',
  badge: 'Draft ready',
  approve: 'Approve and send',
  edit: 'Edit',
  editLabel: 'Edit the draft before sending',
  sendEdited: 'Send edited',
  cancelEdit: 'Cancel editing',
  emptyEdit: 'Write the reply before sending it, or cancel editing.',
  reject: 'Reject',
  sent: 'The draft was sent as you.',
  editedSent: 'Your edited draft was sent.',
  notSent: 'Not sent. Your reply is kept with your failed sends: try it again from the reply box.',
  rejected: 'The draft was rejected. Nothing was sent.',
  closedBy: '{{name}} already decided on this draft.',
  closed: 'This draft no longer fits the conversation.',
  rejectDialog: {
    title: 'Reject this draft',
    description:
      'Nothing is sent to the customer. Your reason is kept with the draft so the assistant can be improved.',
    reason: 'Why are you rejecting it?',
    reasonMissing: 'Choose a reason.',
    note: 'Note',
    submit: 'Reject draft',
    reasons: {
      inaccurate: 'It is wrong',
      incomplete: 'Something is missing',
      wrong_tone: 'The tone is wrong',
      not_needed: 'No reply is needed',
      other: 'Something else',
    },
  },
  ended: {
    approved: '{{name}} sent this draft.',
    edited: '{{name}} sent an edited version of this draft.',
    rejected: '{{name}} rejected this draft: {{reason}}.',
    customer_wrote: 'The draft was replaced: the customer wrote again.',
    owner_changed: 'The draft was set aside: the conversation changed hands.',
    answered: 'The draft was set aside: someone replied by hand.',
    replaced: 'A newer draft replaced this one.',
    resolved: 'The draft was set aside: the conversation was resolved.',
    dismiss: 'Dismiss',
  },
} as const;
