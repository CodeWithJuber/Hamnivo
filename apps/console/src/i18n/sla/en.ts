/**
 * Studio inbox: reply-time targets (H12), the urgent conversations nobody has taken (HNV-08-02)
 * and a claim that lost (HNV-08-06). Merged under `inbox.sla`.
 */
export const slaEn = {
  badge: {
    dueIn: 'Reply due in {{time}}',
    dueSoon: 'Reply due in {{time}}',
    dueNow: 'Reply due now',
    overdue: 'Overdue by {{time}}',
    paused: 'Reply time paused',
    outsideHours: 'Reply time waits for opening hours',
    first_reply: 'First reply',
    next_reply: 'Next reply',
    detail: '{{kind}} target: {{target}}.',
  },
  urgent: {
    title: 'Urgent, nobody has taken it',
    count: '{{n}} urgent',
    more: 'Showing {{shown}} of {{total}}. The soonest deadlines are first.',
    claim: 'Claim',
    claimName: 'Claim the conversation with {{name}}',
    claimed: 'The conversation with {{name}} is yours now.',
    waited: 'Waiting {{time}}',
    reason: {
      customer_request: 'Asked for a person',
      ai_escalated: 'The AI handed it over',
      ai_unavailable: 'The AI could not answer',
      ai_blocked: 'The AI was stopped from answering',
      ai_limit: 'The AI reached its limit',
      staff_release: 'Put back in the queue',
      channel_ai_off: 'The AI does not answer on this channel',
      sla_moved: 'Moved: nobody replied in time',
      other: 'Waiting for a person',
    },
  },
  lost: {
    staff: '{{name}} already took this conversation.',
    ai: '{{name}} is answering this conversation now.',
    external: 'Someone in Chatwoot already took this conversation.',
    none: 'Someone else changed this conversation first. The view now shows where it is.',
  },
  settings: {
    title: 'Reply-time targets',
    description:
      'How soon your team should reply, by priority. Time counts only during the business hours above, and stops while a conversation is snoozed.',
    guide: 'How reply-time targets work',
    enabled: 'Use reply-time targets for this brand',
    enabledHint:
      'Conversations waiting for a person show when a reply is due, and go to the Overdue queue when it is late.',
    priority: 'Priority',
    firstReply: 'First reply within',
    nextReply: 'Next reply within',
    amount: '{{column}} for {{priority}}',
    unit: 'Unit for {{column}}, {{priority}}',
    minutes: 'minutes',
    hours: 'hours',
    empty: 'No target',
    noPriority: 'Conversations with no priority use the Medium targets.',
    invalid:
      '{{column}} for {{priority}}: enter a whole number from 1 minute to 7 days, or leave it empty.',
    save: 'Save targets',
    saved: 'Reply-time targets saved for {{name}}.',
    overdue: {
      title: 'When a conversation goes past its target',
      alertLeads: 'Alert team leads right away',
      alertLeadsHint:
        'People who can assign the conversation hear it in Studio. Those who are not online get an email, at most one every 15 minutes.',
      move: 'Move it if nobody replies',
      moveHint:
        'It goes back to the queue, or to the team you choose, and is offered to the next person. The customer is not told.',
      after: 'Move it after',
      afterUnit: 'Unit for the wait before it is moved',
      afterHint: 'Counted in business hours after it went past its target.',
      moveTo: 'Move it to',
      queue: 'The queue (it keeps its team)',
      team: 'The {{name}} team',
      teamGone: 'A team that no longer takes conversations',
      invalidAfter: 'Move it after: enter a whole number from 1 minute to 7 days.',
    },
    loading: 'Loading reply-time targets',
  },
  moved: 'Back in the queue: nobody replied within the reply-time target.',
} as const;
