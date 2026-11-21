/**
 * Wording of approval and result cards (W16) in English: short, plain sentences that say what
 * will happen, that nothing happens before the customer approves, and what did happen. The other
 * launch languages are in ../locales/ and await native review.
 */
export const ACTION_EN = {
  approvalNeeded: 'Approval needed',
  requestedBy: 'Requested by {{name}}, an AI assistant',
  willHappen: 'What will happen',
  field: 'What changes',
  now: 'Now',
  new: 'New',
  amount: 'Amount',
  nothingYet: 'Nothing changes until you approve.',
  approveBy: 'Approve by {{time}}',
  approve: 'Approve',
  decline: 'Decline',
  sending: 'Sending your answer…',
  approved: 'Approved. You will get a confirmation here when it is done.',
  declined: 'Declined. Nothing was changed.',
  expired: 'This request has expired. Nothing was changed.',
  superseded: 'This request changed, so it can no longer be approved. Nothing was changed.',
  inProgress: 'Being done now.',
  finished: 'Done. See the result below.',
  notDone: 'It could not be done. Nothing was changed.',
  checking: 'Sent, but not confirmed yet. We are checking before trying again.',
  identity: 'Please sign in on the website to confirm it is you, then approve again.',
  identityNote: 'You will be asked to confirm who you are.',
  mismatch: 'This request changed after it was shown. Nothing was approved.',
  unverified: 'This request could not be checked. Nothing can be approved here.',
  error: 'That didn’t work. Please try again.',
  loading: 'Loading the request…',
  result: 'Result',
  done: 'Done',
  failed: 'Not done',
  unknown: 'Being checked',
  cancelled: 'Stopped',
  reference: 'Reference: {{reference}}',
};

export type ActionCopy = typeof ACTION_EN;
