import type { ApprovalCard, ReceiptCard } from '@hamnivo/contracts';
import { toPublicId } from '@hamnivo/db';
import type { z } from 'zod';
import type { CardPublication } from '../commerce/cards.js';
import { sha256Hex } from '../commerce/common.js';
import type { ActionRow, ReceiptRow } from './views.js';

type ApprovalCardT = z.infer<typeof ApprovalCard>;
type ReceiptCardT = z.infer<typeof ReceiptCard>;

const clock = (date: Date) => date.toISOString().slice(11, 16);

/**
 * The approval card a customer sees (W16): what will happen, in plain words, the exact changes
 * and amount, who asked, until when, and how to answer. Everything comes from the action record.
 * Where cards cannot be shown, the text names a code to answer with, unless the customer must
 * first confirm who they are (then the chat is the only way).
 */
export function approvalPublication(
  row: ActionRow,
  senderName: string,
  requestedBy: string | null,
  status: ApprovalCardT['status'] = 'pending',
): CardPublication {
  const publicId = toPublicId('action', row.id);
  const expiresAt = row.expiresAt ?? new Date();
  const card: ApprovalCardT = {
    kind: 'approval',
    version: 1,
    approvalId: publicId,
    title: row.toolTitle.slice(0, 200),
    actionSummary: row.summary.slice(0, 500),
    effects: row.effects.slice(0, 10).map((e) => e.slice(0, 300)),
    resource:
      row.resourceType && row.resourceId
        ? {
            type: row.resourceType,
            id: row.resourceId,
            label: row.resourceLabel ?? row.resourceId,
          }
        : null,
    changes: row.changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
    amount:
      row.amountMinor !== null && row.currency
        ? { amountMinor: row.amountMinor.toString(), currency: row.currency }
        : null,
    risk: row.risk,
    approver: row.approver,
    requestedBy: requestedBy?.slice(0, 80) ?? null,
    stepUp: row.stepUp,
    argumentsHash: row.argumentsHash.toString('hex'),
    code: row.stepUp || status !== 'pending' ? null : row.code,
    status,
    expiresAt: expiresAt.toISOString(),
  };
  const answer = row.stepUp
    ? 'Approve or decline it in the chat after confirming who you are.'
    : `To approve, use the button in the chat or reply "APPROVE ${row.code}". To decline, reply "DECLINE ${row.code}".`;
  const fallbackText =
    status === 'approved'
      ? `Approved: ${row.summary}. You will get a confirmation here when it is done.`
      : status === 'denied'
        ? `Declined: ${row.summary}. Nothing was changed.`
        : [
            `Approval needed: ${row.summary}.`,
            ...row.effects,
            'Nothing changes until you approve.',
            answer,
            `This request expires at ${clock(expiresAt)} UTC.`,
          ].join(' ');
  return {
    ref: { type: 'approval', id: publicId, hash: sha256Hex(card) },
    part: { type: 'card', card, fallbackText: fallbackText.slice(0, 2000) },
    senderName,
  };
}

/** The verified result of an action (G14): shown only from a receipt Hamnivo holds. */
export function actionReceiptPublication(
  row: ActionRow,
  receipt: ReceiptRow,
  summary: string,
  senderName: string,
): CardPublication {
  const outcome: ReceiptCardT['outcome'] =
    receipt.outcome === 'succeeded'
      ? 'completed'
      : receipt.outcome === 'failed'
        ? 'failed'
        : 'unknown';
  const card: ReceiptCardT = {
    kind: 'receipt',
    version: 1,
    receiptId: toPublicId('receipt', receipt.id),
    actionId: toPublicId('action', row.id),
    outcome,
    summary: summary.slice(0, 300),
    reference: receipt.providerRef?.slice(0, 120) ?? null,
    occurredAt: receipt.observedAt.toISOString(),
  };
  const fallback =
    outcome === 'unknown'
      ? `${summary} The result is not confirmed yet; we are checking before trying again.`
      : summary;
  return {
    ref: { type: 'receipt', id: card.receiptId, hash: sha256Hex(card) },
    part: { type: 'card', card, fallbackText: fallback.slice(0, 2000) },
    senderName,
  };
}
