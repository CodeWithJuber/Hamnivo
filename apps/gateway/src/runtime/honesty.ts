/**
 * Output guard for honest AI identity (U09). A reply that claims to be a person, or denies being
 * an AI, is never published. Deterministic patterns in the product's languages; a model that
 * rephrases around them is still bound by the system rules, and staff can review runs.
 */

const RULES: { id: string; pattern: RegExp }[] = [
  {
    id: 'en.claims_human',
    pattern:
      /\b(?:i\s*(?:'|’)?\s*a?m|i\s+am)\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+|living\s+)?(?:human(?:\s+being)?|person|man|woman|human\s+agent)\b/i,
  },
  {
    id: 'en.denies_ai',
    pattern:
      /\b(?:i\s*(?:'|’)?\s*a?m|i\s+am)\s+not\s+(?:a\s+|an\s+)?(?:ai|a\.i\.|bot|robot|chatbot|machine|computer|program|assistant\s+program)\b/i,
  },
  {
    id: 'en.real_person_here',
    pattern:
      /\byou(?:'|’)?re\s+(?:talking|chatting)\s+(?:to|with)\s+a\s+(?:real\s+)?(?:human|person)\b/i,
  },
  {
    id: 'latn.claims_human',
    pattern:
      /\b(?:main|mein|mai|mayn)\s+(?:ek\s+)?(?:asli\s+)?(?:insaan|insan|human|aadmi|admi|banda|bandi)\s+(?:hoon|hun|hu|hon)\b/i,
  },
  {
    id: 'latn.denies_ai',
    pattern:
      /\b(?:main|mein|mai)\s+(?:koi\s+)?(?:bot|robot|ai|machine)\s+(?:nahi|nahin|nai)\s+(?:hoon|hun|hu|hon)\b/i,
  },
  {
    id: 'hi.claims_human',
    pattern: /मैं\s+(?:एक\s+)?(?:असली\s+)?(?:इंसान|इन्सान|मनुष्य|व्यक्ति)\s+(?:हूँ|हूं|हु)/,
  },
  { id: 'hi.denies_ai', pattern: /मैं\s+(?:कोई\s+)?(?:बॉट|रोबोट|एआई|मशीन)\s+नहीं\s+(?:हूँ|हूं|हु)/ },
  { id: 'ur.claims_human', pattern: /میں\s+(?:ایک\s+)?(?:اصلی\s+)?(?:انسان|آدمی|بندہ|شخص)\s+ہوں/ },
  { id: 'ur.denies_ai', pattern: /میں\s+(?:کوئی\s+)?(?:بوٹ|روبوٹ|مشین)\s+نہیں\s+ہوں/ },
  { id: 'ar.claims_human', pattern: /أنا\s+(?:إنسان|انسان|بشر|شخص\s+حقيقي|موظف\s+حقيقي)/ },
  {
    id: 'ar.denies_ai',
    pattern: /(?:لست|أنا\s+لست)\s+(?:روبوت|روبوتا|بوت|آلة|ذكاء\s+اصطناعي|برنامج)/,
  },
];

export interface HonestyVerdict {
  ok: boolean;
  /** Which rule matched; safe to store (no reply text). */
  rule?: string;
}

export function checkHonesty(reply: string): HonestyVerdict {
  const text = reply.normalize('NFC');
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { ok: false, rule: rule.id };
  }
  return { ok: true };
}
