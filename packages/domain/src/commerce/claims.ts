/**
 * Receipt-based completion (X10). An AI reply may say that a payment went through or that a
 * refund was made only when Hamnivo holds the provider's receipt for it. These deterministic
 * patterns find such claims in English, Hinglish and Roman Urdu, Hindi, Urdu and Arabic; the
 * gateway blocks a reply that makes one without a matching receipt. Pending, future, negated,
 * conditional ("once your payment is confirmed…") and questioning statements are not claims.
 * The rules err towards finding a claim: a false alarm only makes the AI rephrase or hand over.
 */

export type CompletionClaim = 'payment_completed' | 'refund_completed';

interface Rule {
  id: string;
  claim: CompletionClaim;
  pattern: RegExp;
}

/** Not inside a question: no question mark before the sentence ends. */
const NOT_QUESTION = String.raw`(?![^.!?؟।\n]*[?؟])`;

/** Not after "once", "if", "when"… (with an optional "your"/"the"). */
const EN_NOT_CONDITIONAL = String.raw`(?<!\b(?:once|when|after|if|until|unless|soon\s+as|before|whether|till)\s+(?:your\s+|the\s+|my\s+)?)`;
const LATN_NOT_CONDITIONAL = String.raw`(?<!\b(?:agar|jab|jaise\s+hi|jab\s+tak|kya|ki\s+kya)\s+(?:aap\s*ka\s+|aap\s*ki\s+|apka\s+|apki\s+|aapka\s+|aapki\s+|mera\s+|meri\s+)?)`;
const HI_NOT_CONDITIONAL = String.raw`(?<!(?:अगर|जब|जैसे\s+ही|जब\s+तक|क्या)\s+(?:आपका\s+|आपकी\s+|आप\s+का\s+|आप\s+की\s+)?)`;
const UR_NOT_CONDITIONAL = String.raw`(?<!(?:اگر|جب|جیسے\s+ہی|جب\s+تک|کیا)\s+(?:آپ\s+کی\s+|آپ\s+کا\s+|آپکی\s+|آپکا\s+)?)`;
/** Also not after a negation ("لم", "ما", "لا", "لن"). */
const AR_NOT_CONDITIONAL = String.raw`(?<!(?:إذا|اذا|عندما|بمجرد\s+أن|بمجرد|حين|هل|لو|لم|ما|لا|لن)\s+)`;
/** JavaScript's \b only knows ASCII letters: a word in these scripts starts after a non-letter. */
const WORD_START = String.raw`(?<![\p{L}\p{M}])`;

const en = (body: string) => new RegExp(`${EN_NOT_CONDITIONAL}${body}${NOT_QUESTION}`, 'i');
const latn = (body: string) => new RegExp(`${LATN_NOT_CONDITIONAL}${body}${NOT_QUESTION}`, 'i');
const hi = (body: string) =>
  new RegExp(`${HI_NOT_CONDITIONAL}${WORD_START}${body}${NOT_QUESTION}`, 'u');
const ur = (body: string) =>
  new RegExp(`${UR_NOT_CONDITIONAL}${WORD_START}${body}${NOT_QUESTION}`, 'u');
const ar = (body: string) =>
  new RegExp(`${AR_NOT_CONDITIONAL}${WORD_START}${body}${NOT_QUESTION}`, 'u');

const RULES: Rule[] = [
  // English: payment.
  {
    id: 'en.payment_done',
    claim: 'payment_completed',
    pattern: en(
      String.raw`\b(?:payment|charge|transaction)\s+(?:has\s+(?:now\s+|already\s+)?been|was|is(?:\s+now)?|got)\s+(?:successfully\s+|fully\s+)?(?:confirmed|received|completed|processed|approved|captured|accepted|successful|complete|done|through)\b`,
    ),
  },
  {
    id: 'en.order_paid',
    claim: 'payment_completed',
    pattern: en(
      String.raw`\b(?:order|invoice|purchase|it)\s+(?:has\s+(?:now\s+|already\s+)?been|is(?:\s+now)?|was)\s+(?:fully\s+|successfully\s+)?paid\b`,
    ),
  },
  {
    id: 'en.you_paid',
    claim: 'payment_completed',
    pattern: en(
      String.raw`\byou(?:'ve|’ve|\s+have)\s+(?:successfully\s+|already\s+)?(?:paid|been\s+charged)\b`,
    ),
  },
  {
    id: 'en.we_received',
    claim: 'payment_completed',
    pattern: en(
      String.raw`\b(?:we|i)(?:'ve|’ve|\s+have)?\s+(?:successfully\s+|already\s+)?received\s+(?:your|the)\s+payment\b`,
    ),
  },
  {
    id: 'en.payment_headline',
    claim: 'payment_completed',
    pattern: en(String.raw`\bpayment\s+(?:confirmed|successful|complete|received)\b`),
  },
  // English: refund.
  {
    id: 'en.refund_done',
    claim: 'refund_completed',
    pattern: en(
      String.raw`\brefund(?:\s+of\s+(?:[^.!?\n]|\.(?=\d)){1,40})?\s+(?:has\s+(?:now\s+|already\s+)?been|was|is(?:\s+now)?)\s+(?:successfully\s+)?(?:issued|processed|completed|sent|confirmed|credited|paid|made|done|complete|successful)\b`,
    ),
  },
  {
    id: 'en.we_refunded',
    claim: 'refund_completed',
    pattern: en(
      String.raw`\b(?:we|i)(?:'ve|’ve|\s+have)?\s+(?:successfully\s+|already\s+)?(?:refunded|issued\s+(?:a|the|your)\s+refund|credited\s+(?:it|the\s+amount)\s+back)\b`,
    ),
  },
  {
    id: 'en.been_refunded',
    claim: 'refund_completed',
    pattern: en(
      String.raw`\b(?:has|have)\s+(?:now\s+|already\s+)?been\s+(?:fully\s+|partially\s+)?refunded\b`,
    ),
  },
  {
    id: 'en.refund_headline',
    claim: 'refund_completed',
    pattern: en(String.raw`\brefund\s+(?:confirmed|successful|complete|issued)\b`),
  },
  // Hinglish and Roman Urdu.
  {
    id: 'latn.payment_done',
    claim: 'payment_completed',
    pattern: latn(
      String.raw`\b(?:payment|paisa|paise|bhugtan|adaigi|adaegi)\s+(?:successfully\s+)?(?:confirm\s+|receive\s+|complete\s+)?(?:ho\s+(?:gaya|gayi|gai|gaye|chuka|chuki)|mil\s+(?:gaya|gayi|gai|gaye|chuka|chuki)|aa\s+(?:gaya|gayi|gai|gaye))\b`,
    ),
  },
  {
    id: 'latn.refund_done',
    claim: 'refund_completed',
    pattern: latn(
      String.raw`\b(?:refund|paisa\s+wapas|paise\s+wapas|raqam\s+wapas)\s+(?:successfully\s+)?(?:process\s+|issue\s+|credit\s+)?(?:ho\s+(?:gaya|gayi|gai|gaye|chuka|chuki)|kar\s+(?:diya|di|diye|dia)|aa\s+(?:gaya|gayi|gai|gaye)|mil\s+(?:gaya|gayi|gai|gaye))\b`,
    ),
  },
  // Hindi.
  {
    id: 'hi.payment_done',
    claim: 'payment_completed',
    pattern: hi(
      String.raw`(?:भुगतान|पेमेंट)\s*(?:सफलतापूर्वक\s*)?(?:(?:प्राप्त|पूरा|कन्फ़र्म|कन्फर्म)\s*)?(?:हो\s*(?:गया|गई|चुका|चुकी)|मिल\s*(?:गया|गई))`,
    ),
  },
  {
    id: 'hi.payment_success',
    claim: 'payment_completed',
    pattern: hi(String.raw`(?:भुगतान|पेमेंट)\s+सफल\s+(?:रहा|हुआ|है)`),
  },
  {
    id: 'hi.refund_done',
    claim: 'refund_completed',
    pattern: hi(
      String.raw`(?:रिफंड|रिफ़ंड|धनवापसी|पैसे\s+वापस)\s*(?:सफलतापूर्वक\s*)?(?:(?:जारी|प्रोसेस)\s*)?(?:हो\s*(?:गया|गई|चुका|चुकी)|कर\s*(?:दिया|दी|दिए)|आ\s*(?:गया|गए))`,
    ),
  },
  // Urdu.
  {
    id: 'ur.payment_done',
    claim: 'payment_completed',
    pattern: ur(
      String.raw`(?:ادائیگی|پیمنٹ|پےمنٹ)\s*(?:کامیابی\s*سے\s*)?(?:موصول\s*)?(?:ہو\s*(?:گئی|گیا|چکی|چکا)|مل\s*(?:گئی|گیا))`,
    ),
  },
  {
    id: 'ur.refund_done',
    claim: 'refund_completed',
    pattern: ur(
      String.raw`(?:ریفنڈ|رقم\s*واپس|پیسے\s*واپس)\s*(?:کامیابی\s*سے\s*)?(?:(?:جاری|پروسیس)\s*)?(?:ہو\s*(?:گیا|گئی|چکا|چکی)|کر\s*(?:دیا|دی|دیے)|آ\s*(?:گیا|گئی|گئے))`,
    ),
  },
  // Arabic.
  {
    id: 'ar.payment_done',
    claim: 'payment_completed',
    pattern: ar(
      String.raw`(?:تم|تمّ|تمت|تمّت)\s+(?:بنجاح\s+)?(?:الدفع|استلام\s+(?:الدفعة|المبلغ|دفعتك)|تأكيد\s+(?:الدفع|الدفعة|دفعتك)|عملية\s+الدفع|السداد)`,
    ),
  },
  {
    id: 'ar.payment_success',
    claim: 'payment_completed',
    pattern: ar(String.raw`(?:الدفع|الدفعة)\s+(?:ناجح|ناجحة|مكتمل|مكتملة)`),
  },
  {
    id: 'ar.refund_done',
    claim: 'refund_completed',
    pattern: ar(
      String.raw`(?:تم|تمّ|تمت|تمّت)\s+(?:بنجاح\s+)?(?:استرداد|استرجاع|رد|إرجاع|إصدار\s+(?:الاسترداد|المبلغ\s+المسترد))`,
    ),
  },
];

export interface ClaimFinding {
  claim: CompletionClaim;
  /** Which rule matched; safe to store (no reply text). */
  rule: string;
}

export function findCompletionClaims(text: string): ClaimFinding[] {
  const normalized = text.normalize('NFC');
  const found: ClaimFinding[] = [];
  for (const rule of RULES) {
    if (found.some((f) => f.claim === rule.claim)) continue;
    if (rule.pattern.test(normalized)) found.push({ claim: rule.claim, rule: rule.id });
  }
  return found;
}

/** What Hamnivo can prove for a conversation: receipts it holds from the provider. */
export interface ReceiptEvidence {
  paymentConfirmed: boolean;
  refundConfirmed: boolean;
}

export type ClaimVerdict = { ok: true } | { ok: false; unsupported: ClaimFinding[] };

/** A reply passes only if every completion it claims is backed by a receipt. */
export function checkCompletionClaims(text: string, evidence: ReceiptEvidence): ClaimVerdict {
  const unsupported = findCompletionClaims(text).filter((finding) =>
    finding.claim === 'payment_completed' ? !evidence.paymentConfirmed : !evidence.refundConfirmed,
  );
  return unsupported.length ? { ok: false, unsupported } : { ok: true };
}
