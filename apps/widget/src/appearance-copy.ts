/**
 * The chat's own words for the brand's look (W03): the rating asked for when a chat is closed
 * and the privacy link, in English. The other launch languages are in locales/ and await native
 * review, like the rest of the widget.
 */
export const APPEARANCE_EN = {
  csat: {
    title: 'How was this chat?',
    hint: 'Choose from 1 (poor) to 5 (great).',
    star: '{{count}} out of 5',
    commentLabel: 'Anything to add? (optional)',
    send: 'Send rating',
    chooseFirst: 'Choose a rating first.',
    thanks: 'Thank you for your feedback.',
    failed: 'The rating was not sent. Please try again.',
  },
  privacy: 'Privacy policy',
} as const;
