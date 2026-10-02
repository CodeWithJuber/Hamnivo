import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Approvals on channels without cards (W16 text fallback). The card's plain text names a short
 * code; the customer answers "APPROVE 4F2A9C" or "DECLINE 4F2A9C" in the same conversation. Only
 * actions the customer may approve, in that conversation, without a fresh identity check, can be
 * decided this way; everything else points to the chat or a person.
 */

/** Six characters that identify an action within its conversation (not a secret). */
export function actionCode(actionPublicId: string): string {
  return bytesToHex(sha256(utf8ToBytes(`hv-action:${actionPublicId}`)))
    .slice(0, 6)
    .toUpperCase();
}

const APPROVE_WORDS = [
  'approve',
  'yes',
  'haan',
  'han',
  'ji',
  'نعم',
  'موافق',
  'हाँ',
  'हां',
  'جی',
  'ہاں',
];
const DECLINE_WORDS = ['decline', 'no', 'nahi', 'nahin', 'لا', 'رفض', 'नहीं', 'نہیں'];

export interface TextDecision {
  decision: 'approve' | 'decline';
  code: string;
}

/**
 * The decision a whole message expresses, or null. The message must be only the word and the
 * code, so a sentence that happens to contain them is never read as an approval.
 */
export function parseTextDecision(text: string): TextDecision | null {
  const match = text
    .normalize('NFC')
    .trim()
    .match(/^(\S+)\s+([0-9A-Fa-f]{6})[.!]?$/u);
  if (!match) return null;
  const word = (match[1] ?? '').toLowerCase();
  const code = (match[2] ?? '').toUpperCase();
  if (APPROVE_WORDS.includes(word)) return { decision: 'approve', code };
  if (DECLINE_WORDS.includes(word)) return { decision: 'decline', code };
  return null;
}
