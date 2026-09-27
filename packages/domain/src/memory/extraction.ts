import type { MemorySlotKey } from './slots.js';

/**
 * The contract between the extraction job and a model. The job sends the customer's new message,
 * with a few earlier ones for context, as JSON (`ExtractionInput`) after instructions that start
 * with this marker; the model answers with `{ "memories": ProposedMemoryJson[] }`. The answer is
 * only a proposal: the write policy decides what is stored.
 */
export const MEMORY_EXTRACTION_MARKER = 'hamnivo:memory-extraction:v1';

export interface ExtractionMessage {
  /** Message id to cite as the source. */
  ref: string;
  text: string;
  /** ISO timestamp. */
  at: string;
}

export interface ExtractionInput {
  /** Earlier messages, only to understand the new ones; never cited. */
  context?: ExtractionMessage[];
  /** The messages to propose from (each is processed once). */
  messages: ExtractionMessage[];
}

export interface ProposedMemoryJson {
  key: string;
  value: string;
  /** Exact words from the cited message. */
  evidence: string;
  sourceRef: string;
  confidence: 'high' | 'medium' | 'low';
  basis: 'stated' | 'inferred';
  sensitivity?: string;
}

interface Rule {
  key: MemorySlotKey;
  pattern: RegExp;
  value: (match: RegExpMatchArray) => string | null;
}

const LANGUAGES: Record<string, string> = {
  english: 'English',
  urdu: 'Urdu',
  arabic: 'Arabic',
  hindi: 'Hindi',
  punjabi: 'Punjabi',
  french: 'French',
  spanish: 'Spanish',
  اردو: 'Urdu',
  العربية: 'Arabic',
  عربي: 'Arabic',
  انگریزی: 'English',
  हिंदी: 'Hindi',
  हिन्दी: 'Hindi',
  अंग्रेज़ी: 'English',
  अंग्रेजी: 'English',
};
const languageOf = (word: string | undefined) =>
  word ? (LANGUAGES[word.toLowerCase()] ?? null) : null;

const CONTACT: Record<string, string> = {
  email: 'Email',
  'e-mail': 'Email',
  mail: 'Email',
  call: 'Phone call',
  phone: 'Phone call',
  ring: 'Phone call',
  text: 'SMS',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

const NOT_A_NAME =
  /^(?:tomorrow|today|tonight|later|back|at|on|in|after|before|when|please|now|again|anytime|asap|soon)$/i;

/** Explicit, simple statements only; anything else is left alone (the mock claims nothing). */
const RULES: readonly Rule[] = [
  {
    key: 'preferred_language',
    pattern:
      /\b(?:reply|answer|respond|write|talk|speak|chat)(?: back)?(?: to me)?(?: only)? in (english|urdu|arabic|hindi|punjabi|french|spanish)\b/i,
    value: (m) => languageOf(m[1]),
  },
  {
    key: 'preferred_language',
    pattern: /\b(english|urdu|hindi|arabic|punjabi) (?:mein|main|me) (?:baat|jawab|reply)\b/i,
    value: (m) => languageOf(m[1]),
  },
  {
    key: 'preferred_language',
    pattern: /(اردو|انگریزی) میں (?:بات|جواب)/u,
    value: (m) => languageOf(m[1]),
  },
  {
    key: 'preferred_language',
    pattern: /(हिंदी|हिन्दी|अंग्रेज़ी|अंग्रेजी) में (?:बात|जवाब)/u,
    value: (m) => languageOf(m[1]),
  },
  {
    key: 'preferred_language',
    pattern: /(?:تحدث|تكلم|أجب|اكتب)(?: معي)? (?:باللغة )?(العربية|عربي)/u,
    value: (m) => languageOf(m[1]),
  },
  {
    key: 'contact_method',
    pattern: /\b(?:contact|reach) me (?:by|via|on|over) (email|e-mail|phone|sms|whatsapp)\b/i,
    value: (m) => CONTACT[(m[1] ?? '').toLowerCase()] ?? null,
  },
  {
    key: 'contact_method',
    pattern: /\b(?:please )?(email|e-mail|whatsapp|text|sms) me\b/i,
    value: (m) => CONTACT[(m[1] ?? '').toLowerCase()] ?? null,
  },
  {
    key: 'contact_time',
    pattern:
      /\b(?:call|contact|reach|phone) me (?:only )?((?:in the (?:morning|afternoon|evening))|(?:after|before) \d{1,2}(?::\d{2})? ?(?:am|pm)?)/i,
    value: (m) => (m[1] ? m[1].trim() : null),
  },
  {
    key: 'preferred_name',
    pattern: /\b(?:please )?call me ([A-Z][\p{L}'-]{1,30})(?![\p{L}])/u,
    value: (m) => (m[1] && !NOT_A_NAME.test(m[1]) ? m[1] : null),
  },
  {
    key: 'delivery_note',
    pattern:
      /\b(?:please )?(?:leave|drop|hand) (?:it|them|the parcel|the package|my parcel|my package|my order|parcels|packages) (with|at|by) ([^.,;!?\n]{2,60})/i,
    value: (m) => (m[1] && m[2] ? `Leave ${m[1].toLowerCase()} ${m[2].trim()}` : null),
  },
  {
    key: 'communication_style',
    pattern:
      /\bkeep (?:it|your replies|the replies|replies|answers|your answers) (short|brief|detailed)\b/i,
    value: (m) => (m[1]?.toLowerCase() === 'detailed' ? 'Detailed replies' : 'Short replies'),
  },
  {
    key: 'size_preference',
    pattern: /\b(?:my size is|i (?:wear|take) (?:a )?size) ([a-z0-9]{1,5})\b/i,
    value: (m) => (m[1] ? m[1].toUpperCase() : null),
  },
  {
    key: 'stated_order_reference',
    pattern: /\border (?:number |no\.? |#)?#?(\d{3,10})\b/i,
    value: (m) => m[1] ?? null,
  },
];

/**
 * Deterministic extraction for the offline mock model (`hamnivo-mock`): explicit statements in
 * English, Roman Urdu, Urdu, Hindi and Arabic, each quoting the words it came from. It never
 * infers, and it proposes each slot at most once per message.
 */
export function mockExtractMemories(input: ExtractionInput): ProposedMemoryJson[] {
  const proposals: ProposedMemoryJson[] = [];
  for (const message of input.messages) {
    const taken = new Set<string>();
    for (const rule of RULES) {
      if (taken.has(rule.key)) continue;
      const match = message.text.match(rule.pattern);
      const value = match ? rule.value(match) : null;
      if (!match || !value) continue;
      taken.add(rule.key);
      proposals.push({
        key: rule.key,
        value,
        evidence: match[0].trim(),
        sourceRef: message.ref,
        confidence: 'high',
        basis: 'stated',
      });
    }
  }
  return proposals;
}
