/**
 * Studio inbox: tickets (H19). A ticket is a conversation with a reference number, a state and a
 * priority; its history stays in the conversation.
 */
export const ticketsEn = {
  guide: 'How tickets work',
  states: {
    label: 'Ticket state',
    open: 'Open',
    pending: 'Pending',
    closed: 'Closed',
    all: 'All',
  },
  stateBadge: {
    open: 'Open',
    pending: 'Waiting for the customer',
    closed: 'Closed',
  },
  stateHint: {
    open: 'Your team is working on it.',
    pending: 'Waiting for the customer. It opens again when they write.',
    closed: 'Done. It opens again if the customer writes.',
  },
  priority: {
    label: 'Priority',
    any: 'Any priority',
    none: 'No priority',
    urgent: 'Urgent',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  },
  priorityBadge: {
    urgent: 'Urgent',
    high: 'High priority',
    medium: 'Medium priority',
    low: 'Low priority',
  },
  reference: 'Ticket {{reference}}',
  source: {
    offline_form: 'Left with the contact form',
    staff: 'Made a ticket by your team',
    automation: 'Made a ticket by an automation',
    email: 'Came in by email',
  },
  stateChanged: 'Ticket {{reference}} is now: {{state}}.',
  priorityChanged: 'Priority set to {{priority}}.',
  priorityCleared: 'Priority cleared.',
  noPermission: 'Your role can’t change the state or priority of conversations.',
  more: 'More actions',
  make: {
    item: 'Make this a ticket',
    title: 'Make this conversation a ticket',
    description:
      'It gets a reference number, a state and a priority. The history stays in this conversation.',
    priority: 'Priority',
    submit: 'Create ticket',
    done: 'Ticket {{reference}} created.',
  },
  emptyFiltered: {
    title: 'No tickets match',
    description: 'Try another state or priority, or see every ticket.',
    action: 'See all tickets',
  },
} as const;
