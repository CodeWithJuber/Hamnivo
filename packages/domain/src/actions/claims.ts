/**
 * Receipt-based completion for AI actions (G14, extending X10). A reply may say that it changed,
 * created or cancelled something only when Hamnivo holds a succeeded receipt for an action in the
 * conversation and nothing else is still waiting (approval, execution or an unknown outcome), and
 * may say it checked something only when a lookup actually completed. These deterministic
 * patterns find such claims in English, Hinglish and Roman Urdu, Hindi, Urdu and Arabic. Future,
 * negated, conditional and questioning statements are not claims. A false alarm only makes the AI
 * rephrase; a missed false claim would mislead the customer, so the patterns err towards finding.
 */

export type ActionClaim = 'action_completed' | 'action_checked';

interface Rule {
  id: string;
  claim: ActionClaim;
  pattern: RegExp;
}

const NOT_QUESTION = String.raw`(?![^.!?؟।\n]*[?؟])`;
const EN_NOT_CONDITIONAL = String.raw`(?<!\b(?:once|when|after|if|until|unless|soon\s+as|before|whether|till)\s+(?:your\s+|the\s+|my\s+|it\s+|this\s+|that\s+)?(?:\w+\s+){0,2})`;
const LATN_NOT_CONDITIONAL = String.raw`(?<!\b(?:agar|jab|jaise\s+hi|jab\s+tak|kya)\s+(?:\w+\s+){0,3})`;
const WORD_START = String.raw`(?<![\p{L}\p{M}])`;
const NATIVE_NOT_CONDITIONAL = String.raw`(?<!(?:अगर|जब|क्या|اگر|جب|کیا|إذا|اذا|عندما|هل|لو|لم|لا|لن|ما)\s+(?:[\p{L}\p{M}]+\s+){0,2})`;

const en = (body: string) => new RegExp(`${EN_NOT_CONDITIONAL}${body}${NOT_QUESTION}`, 'i');
const latn = (body: string) => new RegExp(`${LATN_NOT_CONDITIONAL}${body}${NOT_QUESTION}`, 'i');
const native = (body: string) =>
  new RegExp(`${NATIVE_NOT_CONDITIONAL}${WORD_START}${body}${NOT_QUESTION}`, 'u');

/**
 * Verbs of changing something. Payment and refund words (paid, charged, refunded, processed) are
 * commerce's claims (X10) and checked against payment and refund receipts there.
 */
const CHANGE_VERBS =
  'updated|changed|cancell?ed|created|submitted|booked|scheduled|rescheduled|reset|removed|renewed|upgraded|downgraded|arranged|corrected|activated|deactivated|unlocked';

const RULES: Rule[] = [
  {
    id: 'en.i_changed',
    claim: 'action_completed',
    pattern: en(
      String.raw`\b(?:i|we)(?:'ve|’ve|\s+have)?\s+(?:just\s+|now\s+|already\s+|successfully\s+|gone\s+ahead\s+and\s+)?(?:${CHANGE_VERBS})\b`,
    ),
  },
  {
    id: 'en.has_been_changed',
    claim: 'action_completed',
    pattern: en(
      String.raw`\b(?:has|have)\s+(?:now\s+|just\s+|already\s+)?been\s+(?:successfully\s+)?(?:${CHANGE_VERBS})\b`,
    ),
  },
  {
    id: 'en.is_now_changed',
    claim: 'action_completed',
    pattern: en(
      String.raw`\b(?:is|are|was|were)\s+(?:now\s+)?(?:successfully\s+)(?:${CHANGE_VERBS})\b|\b(?:is|are)\s+now\s+(?:${CHANGE_VERBS})\b`,
    ),
  },
  {
    id: 'en.all_done',
    claim: 'action_completed',
    pattern: en(String.raw`\b(?:all\s+done|it(?:'s|’s|\s+is)\s+done|that(?:'s|’s|\s+is)\s+done)\b`),
  },
  {
    id: 'en.i_checked',
    claim: 'action_checked',
    pattern: en(
      String.raw`\b(?:i|we)(?:'ve|’ve|\s+have)?\s+(?:just\s+|now\s+|already\s+)?(?:checked|looked\s+up|verified|confirmed)\b`,
    ),
  },
  {
    id: 'latn.kar_diya',
    claim: 'action_completed',
    pattern: latn(
      String.raw`\b(?:update|change|cancel|book|schedule|reset|submit|badal|tabdeel|khatam)\s+(?:kar\s+(?:diya|di|diye|dia|chuka|chuki)|ho\s+(?:gaya|gayi|gai|gaye|chuka|chuki))\b`,
    ),
  },
  {
    id: 'latn.check_kar_liya',
    claim: 'action_checked',
    pattern: latn(String.raw`\b(?:check|verify|pata)\s+kar\s+(?:liya|li|lia|chuka|chuki)\b`),
  },
  {
    id: 'hi.kar_diya',
    claim: 'action_completed',
    pattern: native(
      String.raw`(?:अपडेट|बदल|रद्द|कैंसल|बुक|जमा)\s*(?:कर\s*(?:दिया|दी|दिए)|हो\s*(?:गया|गई|गए|चुका|चुकी))`,
    ),
  },
  {
    id: 'ur.kar_diya',
    claim: 'action_completed',
    pattern: native(
      String.raw`(?:اپڈیٹ|تبدیل|منسوخ|کینسل|بک)\s*(?:کر\s*(?:دیا|دی|دیے)|ہو\s*(?:گیا|گئی|گئے|چکا|چکی))`,
    ),
  },
  {
    id: 'ar.tamma',
    claim: 'action_completed',
    pattern: native(
      String.raw`(?:تم|تمّ|تمت|تمّت)\s+(?:بنجاح\s+)?(?:تحديث|تغيير|تعديل|إلغاء|الغاء|حجز|إنشاء|انشاء|إرسال\s+الطلب)`,
    ),
  },
  {
    id: 'ar.checked',
    claim: 'action_checked',
    pattern: native(String.raw`(?:تحققت|تحقّقت|راجعت|تم\s+التحقق)`),
  },
];

export interface ActionClaimFinding {
  claim: ActionClaim;
  /** Which rule matched; safe to store (no reply text). */
  rule: string;
}

export function findActionClaims(text: string): ActionClaimFinding[] {
  const normalized = text.normalize('NFC');
  const found: ActionClaimFinding[] = [];
  for (const rule of RULES) {
    if (found.some((f) => f.claim === rule.claim)) continue;
    if (rule.pattern.test(normalized)) found.push({ claim: rule.claim, rule: rule.id });
  }
  return found;
}

/** What Hamnivo can prove about the conversation's actions, from its own records. */
export interface ActionEvidence {
  /** Changes with a succeeded receipt. */
  completedChanges: number;
  /** Lookups that completed. */
  completedLookups: number;
  /** Actions still waiting for approval, being sent, or with an unknown outcome. */
  pending: number;
}

export type ActionClaimVerdict = { ok: true } | { ok: false; unsupported: ActionClaimFinding[] };

export function checkActionClaims(text: string, evidence: ActionEvidence): ActionClaimVerdict {
  const unsupported = findActionClaims(text).filter((finding) =>
    finding.claim === 'action_completed'
      ? evidence.completedChanges === 0 || evidence.pending > 0
      : evidence.completedLookups + evidence.completedChanges === 0,
  );
  return unsupported.length ? { ok: false, unsupported } : { ok: true };
}

export const ACTION_CLAIM_CORRECTION =
  'Your previous draft said something was changed, done or checked, but there is no confirmed ' +
  'result for it. Do not say it is done. Say what is actually known: that it is waiting for ' +
  'approval, that the result is not confirmed yet, or that you cannot do it, and point to the ' +
  'card in the chat.';
