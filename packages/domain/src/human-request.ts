import type { LanguageSlice } from './decisions.js';

/**
 * Deterministic detection of an explicit request for a person (handoff precedence 1, J04, U02). It
 * runs before any decision provider, and no provider can veto it. Phrase lists cover English,
 * Hinglish, Roman Urdu, Arabic, Hindi and Urdu, with spelling variants, negation and common false
 * positives ("human resources", "are you human?", "agent number 5").
 */
export interface HumanRequestDetection {
  requested: boolean;
  /** The phrase that matched, after normalization. */
  phrase?: string;
  language?: LanguageSlice;
}

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\u061c\ufeff]/g;
// Latin accents; Arabic harakat, hamza and madda (split off by NFKD), superscript alef, Quranic
// marks and tatweel; the Devanagari nukta and virama.
const MARKS = /[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed\u0640\u093c\u094d]/g;
const LETTERS: Readonly<Record<string, string>> = {
  ی: 'ي',
  ى: 'ي',
  ے: 'ي',
  ک: 'ك',
  ڪ: 'ك',
  ہ: 'ه',
  ھ: 'ه',
  ة: 'ه',
  ۃ: 'ه',
  ە: 'ه',
  ٱ: 'ا',
  ں: 'ن',
  // Anusvara and chandrabindu become न, so इंसान and इन्सान (virama removed) meet.
  '\u0901': 'न',
  '\u0902': 'न',
};
const LETTER_VARIANTS = new RegExp(`[${Object.keys(LETTERS).join('')}]`, 'g');
const NATIVE_DIGITS = /[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f]/g;
const APOSTROPHES = /['’‘`´ʼ]/g;
const SEPARATORS = /[^\p{L}\p{M}\p{N}]+/gu;
// Doubled letters carry no meaning in chat spelling: insaan/insan, baat/bat, chahiyee/chahiye.
const REPEATS = /(\p{L})\1+/gu;

function nativeDigit(digit: string): string {
  const code = digit.codePointAt(0) ?? 0;
  const zero = code >= 0x0966 ? 0x0966 : code >= 0x06f0 ? 0x06f0 : 0x0660;
  return String(code - zero);
}

/**
 * Folds case and spelling variants so phrase lists match what people type: Arabic and Urdu letter
 * variants (ي/ی, ك/ک, ه/ہ/ھ, ة/ہ, أ/إ/آ → ا), diacritics and tatweel, Devanagari nukta and virama
 * forms, apostrophes, punctuation, spacing and repeated letters.
 */
export function normalizeForMatching(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(ZERO_WIDTH, '')
    .replace(MARKS, '')
    .replace(LETTER_VARIANTS, (letter) => LETTERS[letter] ?? letter)
    .replace(NATIVE_DIGITS, nativeDigit)
    .replace(APOSTROPHES, '')
    .replace(SEPARATORS, ' ')
    .replace(REPEATS, '$1')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Phrase patterns. A pattern is a sequence of slots; each slot lists alternatives (normalized when
// compiled). An empty alternative makes the slot optional. Matches start and end on word edges.

type Slot = readonly string[];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function alternatives(slot: Slot): string {
  const forms = [...new Set(slot.filter(Boolean).map(normalizeForMatching))];
  return forms
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
}

/** Words that turn a person noun into something else: "human resources", "agent number". */
const NOT_A_PERSON = alternatives([
  'resources',
  'resource',
  'rights',
  'error',
  'errors',
  'nature',
  'number',
  'numbers',
  'email',
  'phone',
  'address',
  'hours',
  'website',
]);

function pattern(slots: readonly Slot[], anchor: 'words' | 'end' | 'whole' = 'words'): RegExp {
  const body = slots
    .map((slot, index) => {
      const alts = alternatives(slot);
      if (index === slots.length - 1) return `(?:${alts})`;
      return slot.includes('') ? `(?:(?:${alts}) )?` : `(?:${alts}) `;
    })
    .join('');
  const start = anchor === 'whole' ? '^' : '(?<![^ ])';
  const end = anchor === 'words' ? `(?![^ ])(?! (?:${NOT_A_PERSON})(?![^ ]))` : '$';
  return new RegExp(`${start}${body}${end}`, 'gu');
}

interface Grammar {
  language: LanguageSlice;
  patterns: readonly RegExp[];
  /** Whole messages that are a request on their own ("agent", "انسان"). */
  bare: RegExp;
  negated(tokens: readonly string[], start: number, end: number): boolean;
}

const normalizedSet = (words: readonly string[]) => new Set(words.map(normalizeForMatching));

/**
 * SVO languages (English, Arabic): a negator governs the verb chain before the match ("I don't
 * want to talk to…", "لا أريد…"). Walk back through the chain; any other word ends the search, so
 * "no bot, human please" and "this is not working, talk to a human" stay requests. A weak negator
 * ("no") counts only right before the match or before "need".
 */
function negatedBefore(options: {
  negators: readonly string[];
  chain: readonly string[];
  weak?: readonly string[];
  needs?: readonly string[];
}): Grammar['negated'] {
  const negators = normalizedSet(options.negators);
  const chain = normalizedSet(options.chain);
  const weak = normalizedSet(options.weak ?? []);
  const needs = normalizedSet(options.needs ?? []);
  return (tokens, start) => {
    for (let i = start - 1; i >= 0; i--) {
      const token = tokens[i] ?? '';
      if (negators.has(token)) return true;
      if (weak.has(token)) return i === start - 1 || needs.has(tokens[i + 1] ?? '');
      if (!chain.has(token)) return false;
    }
    return false;
  };
}

/**
 * SOV languages (Hindi, Urdu and their Latin forms): negation sits before the verb, which breaks
 * the phrase ("insaan nahi chahiye"). What remains is a negator right after the match
 * ("insaan chahiye nahi"), unless it means "otherwise" ("nahi to"), or a mixed-in English "no"
 * right before it ("no insaan please").
 */
function negatedAfter(
  negators: readonly string[],
  otherwise: readonly string[],
  weakBefore: readonly string[] = [],
): Grammar['negated'] {
  const not = normalizedSet(negators);
  const unless = normalizedSet(otherwise);
  const weak = normalizedSet(weakBefore);
  return (tokens, start, end) =>
    weak.has(tokens[start - 1] ?? '') ||
    (not.has(tokens[end] ?? '') && !unless.has(tokens[end + 1] ?? ''));
}

// English -------------------------------------------------------------------------------------

const EN_DET = ['', 'a', 'an', 'the', 'some', 'your', 'any', 'another', 'one of your'];
const EN_ADJ = ['', 'real', 'live', 'actual', 'proper', 'genuine', 'human'];
const EN_MOD = [
  '',
  'support',
  'customer support',
  'customer service',
  'customer care',
  'service',
  'sales',
  'billing',
  'account',
  'technical support',
  'tech support',
  'help desk',
  'helpdesk',
];
const EN_NOUN = [
  'human',
  'humans',
  'human being',
  'human beings',
  'person',
  'people',
  'agent',
  'agents',
  'representative',
  'representatives',
  'rep',
  'customer service',
  'customer support',
  'customer care',
  'team',
  'staff',
  'staff member',
  'member of staff',
  'team member',
  'employee',
  'operator',
  'manager',
  'supervisor',
  'executive',
  'advisor',
  'adviser',
  'someone',
  'somebody',
  'human help',
  'human support',
  'human assistance',
  'live support',
  'live help',
];
const EN_TALK = ['talk', 'speak', 'chat', 'communicate', 'converse'];
const EN_TO = ['to', 'with'];
const EN_CONNECT = [
  'connect',
  'transfer',
  'put',
  'pass',
  'forward',
  'redirect',
  'route',
  'escalate',
  'hand',
  'switch',
  'send',
];
const EN_OBJECT = [
  '',
  'me',
  'us',
  'this',
  'it',
  'my call',
  'my chat',
  'my case',
  'my issue',
  'this chat',
];
const EN_TO_TARGET = ['to', 'with', 'through to', 'over to', 'across to'];
const EN_WANT = [
  'want',
  'wanna',
  'need',
  'request',
  'require',
  'demand',
  'prefer',
  'would like',
  'id like',
];
const EN_PERSON = [EN_DET, EN_ADJ, EN_MOD, EN_NOUN] as const;

const english: Grammar = {
  language: 'en',
  patterns: [
    pattern([EN_TALK, EN_TO, ...EN_PERSON]),
    pattern([EN_CONNECT, EN_OBJECT, EN_TO_TARGET, ...EN_PERSON]),
    pattern([
      ['be', 'get', 'being', 'getting'],
      ['connected', 'transferred', 'put through', 'passed', 'forwarded', 'escalated', 'routed'],
      EN_TO_TARGET,
      ...EN_PERSON,
    ]),
    pattern([EN_WANT, ...EN_PERSON]),
    pattern([['get', 'give', 'find', 'bring', 'fetch'], ['', 'me', 'us'], ...EN_PERSON]),
    pattern([['help', 'assistance', 'support'], ['from'], ...EN_PERSON]),
    pattern([['ask', 'asking', 'asked', 'requesting', 'requested'], ['for'], ...EN_PERSON]),
    pattern([...EN_PERSON, ['please', 'pls', 'plz']]),
    pattern([['please', 'pls', 'plz'], ...EN_PERSON]),
    pattern([
      ['is there', 'are there'],
      ...EN_PERSON,
      ['i can', 'i could', 'to', 'who can', 'that can'],
      ['talk', 'speak', 'chat', 'help'],
    ]),
  ],
  bare: pattern(
    [
      ['', 'a', 'an', 'the'],
      ['', 'real', 'live', 'human', 'actual'],
      [
        'human',
        'humans',
        'human being',
        'person',
        'agent',
        'support agent',
        'representative',
        'rep',
        'operator',
        'customer service',
        'customer care',
        'customer support',
        'manager',
        'supervisor',
      ],
    ],
    'whole',
  ),
  negated: negatedBefore({
    negators: ['not', 'dont', 'didnt', 'doesnt', 'never', 'wont', 'wouldnt', 'without', 'nor'],
    weak: ['no'],
    needs: ['need'],
    chain: [
      ...['i', 'im', 'id', 'am', 'to', 'be', 'me', 'us', 'let', 'can', 'could', 'may', 'must'],
      ...['want', 'wanna', 'need', 'would', 'd', 'like', 'rather', 'really', 'even', 'actually'],
      ...['just', 'please', 'pls', 'plz', 'think', 'believe', 'get', 'ask', 'also', 'still'],
      ...['have', 'should', 'trying', 'try', 'tried', 'going', 'gonna'],
    ],
  }),
};

// Hinglish and Roman Urdu -----------------------------------------------------------------------
// The two share grammar in Latin script. Phrases whose person noun is English or Hindi are tagged
// Hinglish; phrases with Urdu nouns (insaan, banda, numainda) are tagged Roman Urdu.

const LATIN_DET = ['', 'kisi', 'kisy', 'koi', 'ek'];
const SE = ['se', 'say', 'sey', 'sy', 'c'];
const BAAT = ['baat', 'bt', 'baat cheet', 'guftagu'];
const LATIN_VERBS = [
  ...['karni', 'krni', 'karna', 'krna', 'karne', 'krne'],
  ...['karao', 'krao', 'karado', 'kara do', 'kra do', 'kara dein', 'kara den', 'kara dijiye'],
  ...['karaen', 'karain', 'karayen', 'karaye', 'karaiye', 'kara de', 'kara dy'],
  ...['karwao', 'krwao', 'karvao', 'krvao', 'karwado', 'krwado', 'karwa do', 'krwa do'],
  ...['karwa dein', 'karwa den', 'karwa dain', 'krwa dain', 'karwa dijiye', 'karwa dijie'],
  ...['karwaen', 'karwain', 'karwayen', 'karwaye', 'karwaiye', 'karvaiye', 'karwa de', 'karwa dy'],
  ...['kar sakta', 'kar sakti', 'kar sakte', 'kr sakta', 'kr sakti', 'kr sakte', 'kar skta'],
  ...['kar skti', 'kar skte', 'kr skta', 'kr skti', 'kr skte', 'kar sakun', 'kar sakon'],
  ...['ho sakti', 'ho skti', 'ho sakta', 'ho skta'],
  ...['karna chahta', 'karna chahti', 'karna chahte', 'krna chahta', 'krna chahti'],
  ...['karna chahunga', 'karna chahungi', 'karni chahiye', 'krni chahiye'],
];
const CHAHIYE = [
  ...['chahiye', 'chahie', 'chaiye', 'chahye', 'chahiay', 'chahiyay', 'chahiya', 'chayie'],
  ...['chaye', 'chahyie', 'chahiyeh', 'chahiae', 'mangta', 'mangti', 'mangte'],
];
const MILAO = [
  ...['milao', 'milwao', 'mila do', 'milwa do', 'milado', 'milwado', 'mila dein', 'milwa dein'],
  ...['milaen', 'milwaen', 'milayen', 'milwayen', 'milaiye', 'milwaiye', 'jodo', 'jod do'],
  ...['connect karo', 'connect kardo', 'connect kar do', 'connect karein', 'connect karen'],
  ...['connect karwao', 'connect kara do', 'connect krwa do', 'connect kro'],
];
const KO = ['ko', 'ku', 'kou'];
const BULAO = [
  ...['bulao', 'bulaen', 'bulayen', 'bula do', 'bulado', 'bulwao', 'bulwa do', 'bulaiye'],
  ...['bulwaiye', 'bula lo', 'call karo'],
];
const LATIN_TO = ['ko', 'pe', 'par', 'pr', 'ke pas', 'ke paas', 'k pas'];
const TRANSFER = ['transfer', 'forward', 'connect'];
const KARO = [
  ...['karo', 'kro', 'kardo', 'kar do', 'kr do', 'krdo', 'karein', 'karen', 'kar dein'],
  ...['kar den', 'kar dijiye', 'kar dijie', 'karwao', 'krwao'],
];
const LATIN_PLEASE = ['please', 'pls', 'plz'];
const SOV_LATIN_NEGATED = negatedAfter(
  ['nahi', 'nahin', 'nai', 'nhi', 'nahee'],
  ['to', 'toh'],
  ['no'],
);

function latinSov(
  language: LanguageSlice,
  nouns: readonly string[],
  bare: readonly string[],
): Grammar {
  return {
    language,
    patterns: [
      pattern([LATIN_DET, nouns, SE, BAAT, LATIN_VERBS]),
      pattern([LATIN_DET, nouns, SE, BAAT], 'end'),
      pattern([LATIN_DET, nouns, SE, BAAT, LATIN_PLEASE], 'end'),
      pattern([LATIN_DET, nouns, CHAHIYE]),
      pattern([LATIN_DET, nouns, SE, MILAO]),
      pattern([LATIN_DET, nouns, KO, BULAO]),
      pattern([LATIN_DET, nouns, LATIN_TO, TRANSFER, KARO]),
      pattern([TRANSFER, KARO, LATIN_DET, nouns]),
      pattern([nouns, LATIN_PLEASE]),
    ],
    bare: pattern([['', 'koi', 'kisi', 'asli'], bare], 'whole'),
    negated: SOV_LATIN_NEGATED,
  };
}

const hinglish = latinSov(
  'hinglish',
  [
    ...['agent', 'agents', 'human', 'humans', 'person', 'real person', 'live person', 'real human'],
    ...['human agent', 'live agent', 'customer care', 'customer service', 'customer support'],
    ...['customer care executive', 'executive', 'representative', 'rep', 'staff', 'team'],
    ...['support team', 'support staff', 'manager', 'supervisor'],
    ...['vyakti', 'aadmi', 'karmchari', 'pratinidhi', 'manushya'],
  ],
  ['vyakti', 'aadmi'],
);

const romanUrdu = latinSov(
  'roman-urdu',
  [
    ...['insaan', 'insaano', 'banda', 'bande', 'bandey', 'bandy', 'shakhs', 'kisi'],
    ...['numainda', 'numainde', 'numaindey', 'numainday', 'mulazim', 'karkun'],
    ...['asli insaan', 'zinda insaan', 'haqeeqi insaan'],
  ],
  ['insaan', 'banda', 'bande'],
);

// Hindi (Devanagari) ----------------------------------------------------------------------------

const hindi: Grammar = (() => {
  const det = ['', 'किसी', 'कोई', 'एक'];
  const nouns = [
    ...['इंसान', 'इन्सान', 'इंसानों', 'व्यक्ति', 'आदमी', 'बंदा', 'बंदे', 'मनुष्य', 'किसी'],
    ...['एजेंट', 'एजेन्ट', 'ह्यूमन', 'कर्मचारी', 'प्रतिनिधि', 'स्टाफ', 'टीम', 'मैनेजर'],
    ...['कस्टमर केयर', 'कस्टमर सर्विस', 'कस्टमर सपोर्ट', 'ग्राहक सेवा', 'सपोर्ट टीम', 'असली इंसान'],
  ];
  const verbs = [
    ...['करनी', 'करना', 'करने', 'कराओ', 'करवाओ', 'करा दो', 'करवा दो', 'करा दें', 'करवा दें'],
    ...['करा दीजिए', 'करवा दीजिए', 'करा दीजिये', 'करवा दीजिये', 'कराइए', 'करवाइए', 'कराइये'],
    ...['करवाइये', 'कराएं', 'करवाएं', 'कर सकता', 'कर सकती', 'कर सकते', 'कर सकूं', 'हो सकती'],
    ...['हो सकता', 'करना चाहता', 'करना चाहती', 'करना चाहते', 'करनी चाहिए'],
  ];
  const connect = [
    ...['मिलाओ', 'मिलवाओ', 'मिला दो', 'मिलवा दो', 'मिलाइए', 'मिलवाइए', 'मिला दीजिए'],
    ...['मिलवा दीजिए', 'जोड़ो', 'जोड़ दो', 'जोड़िए', 'कनेक्ट करो', 'कनेक्ट कर दो', 'कनेक्ट करें'],
  ];
  const call = ['बुलाओ', 'बुला दो', 'बुलाइए', 'बुलाइये', 'बुलवाओ', 'बुलवा दो'];
  const transfer = ['ट्रांसफर', 'ट्रान्सफर', 'फॉरवर्ड', 'कनेक्ट'];
  const karo = ['करो', 'कर दो', 'करें', 'कीजिए', 'करिए', 'कर दीजिए'];
  return {
    language: 'hi',
    patterns: [
      pattern([det, nouns, ['से'], ['बात'], verbs]),
      pattern([det, nouns, ['से'], ['बात']], 'end'),
      pattern([det, nouns, ['चाहिए', 'चाहिये', 'चाहीए']]),
      pattern([det, nouns, ['से'], connect]),
      pattern([det, nouns, ['को'], call]),
      pattern([det, nouns, ['को', 'पर', 'पे'], transfer, karo]),
    ],
    bare: pattern(
      [
        ['', 'कोई', 'असली'],
        ['इंसान', 'एजेंट', 'व्यक्ति', 'कस्टमर केयर'],
      ],
      'whole',
    ),
    negated: negatedAfter(['नहीं', 'नही'], ['तो']),
  };
})();

// Urdu (Arabic script) --------------------------------------------------------------------------

const urdu: Grammar = (() => {
  const det = ['', 'کسی', 'کوئی', 'ایک'];
  const nouns = [
    ...['انسان', 'بندہ', 'بندے', 'آدمی', 'شخص', 'ایجنٹ', 'ہیومن', 'نمائندہ', 'نمائندے', 'ملازم'],
    ...['عملہ', 'عملے', 'اسٹاف', 'سٹاف', 'ٹیم', 'منیجر', 'مینیجر', 'کسی'],
    ...['کسٹمر کیئر', 'کسٹمر سروس', 'کسٹمر سپورٹ', 'اصلی انسان', 'حقیقی انسان'],
  ];
  const verbs = [
    ...['کرنی', 'کرنا', 'کرنے', 'کراؤ', 'کرواؤ', 'کرا دو', 'کروا دو', 'کرا دیں', 'کروا دیں'],
    ...['کرائیں', 'کروائیں', 'کرائیے', 'کروائیے', 'کرا دیجیے', 'کروا دیجیے', 'کرا دیجئے'],
    ...['کروا دیجئے', 'کر سکتا', 'کر سکتی', 'کر سکتے', 'کر سکوں', 'ہو سکتی', 'ہو سکتا'],
    ...['کرنا چاہتا', 'کرنا چاہتی', 'کرنا چاہتے', 'کرنی چاہیے'],
  ];
  const connect = [
    ...['ملاؤ', 'ملواؤ', 'ملا دو', 'ملوا دو', 'ملائیں', 'ملوائیں', 'ملا دیں', 'ملوا دیں'],
    ...['ملائیے', 'ملوائیے', 'جوڑیں', 'جوڑ دیں', 'کنیکٹ کریں', 'کنیکٹ کر دیں', 'کنیکٹ کرو'],
  ];
  const call = ['بلاؤ', 'بلا دو', 'بلائیں', 'بلا دیں', 'بلوائیں', 'بلوا دیں', 'بلائیے'];
  const transfer = ['ٹرانسفر', 'فارورڈ', 'کنیکٹ'];
  const karo = ['کریں', 'کرو', 'کر دیں', 'کر دو', 'کیجیے', 'کیجئے'];
  return {
    language: 'ur',
    patterns: [
      pattern([det, nouns, ['سے'], ['بات'], verbs]),
      pattern([det, nouns, ['سے'], ['بات']], 'end'),
      pattern([det, nouns, ['چاہیے', 'چاہئے', 'چاہیئے', 'چائیے']]),
      pattern([det, nouns, ['سے'], connect]),
      pattern([det, nouns, ['کو'], call]),
      pattern([det, nouns, ['کو', 'پر', 'پہ'], transfer, karo]),
      pattern([nouns, ['پلیز', 'مہربانی']]),
    ],
    bare: pattern(
      [
        ['', 'کوئی', 'اصلی'],
        ['انسان', 'ایجنٹ', 'بندہ', 'نمائندہ', 'کسٹمر کیئر'],
      ],
      'whole',
    ),
    negated: negatedAfter(['نہیں', 'نہ'], ['تو']),
  };
})();

// Arabic ----------------------------------------------------------------------------------------

/** Arabic attaches the article and prepositions: موظف, الموظف, بموظف, لموظف, للموظف. */
function withPrefixes(nouns: readonly string[]): string[] {
  return nouns.flatMap((noun) => {
    const [first = '', ...rest] = noun.split(' ');
    const bare = first.startsWith('ال') ? first.slice(2) : first;
    return ['', 'ال', 'ب', 'بال', 'ل', 'لل'].map((prefix) => [prefix + bare, ...rest].join(' '));
  });
}

const arabic: Grammar = (() => {
  const nouns = [
    ...withPrefixes([
      ...['موظف', 'موظفة', 'إنسان', 'شخص', 'بشري', 'وكيل', 'ممثل', 'مندوب', 'مسؤول', 'مشرف'],
      ...['مدير', 'موظف حقيقي', 'إنسان حقيقي', 'شخص حقيقي', 'موظف بشري', 'خدمة العملاء'],
      ...['ممثل خدمة العملاء', 'موظف خدمة العملاء', 'الدعم الفني', 'فريق الدعم', 'موظف الدعم'],
    ]),
    // Pronoun-like words take no article: الأحد is Sunday.
    ...['أحد', 'حد', 'حدا', 'أحد الموظفين', 'بني آدم'],
  ];
  const want = [
    ...['أريد', 'أود', 'أحتاج', 'أحتاج إلى', 'أرغب', 'أرغب في', 'أبي', 'أبغى', 'ابغي', 'بدي'],
    ...['عايز', 'عاوز', 'عايزة', 'عاوزة', 'محتاج', 'محتاجة', 'ممكن', 'يمكنني', 'أستطيع'],
    ...['أقدر', 'ودي', 'نريد', 'نبي', 'بدنا', 'أطلب'],
  ];
  const talk = [...['أتحدث', 'أتكلم', 'أكلم', 'أحكي', 'أتواصل', 'أخاطب', 'نتكلم', 'نتحدث', 'نحكي']];
  const talking = ['التحدث', 'التكلم', 'التواصل', 'الحكي'];
  const to = ['', 'مع', 'إلى', 'الى', 'ل'];
  const transfer = [
    ...['حولني', 'حولوني', 'وصلني', 'وصلوني', 'أوصلني', 'صلني', 'اربطني', 'اربطوني'],
    ...['انقلني', 'أحلني', 'أعطني', 'عطني', 'جيب لي', 'جيبلي', 'ابعتلي'],
  ];
  const please = ['من فضلك', 'لو سمحت', 'لو سمحتي', 'رجاء', 'رجاءً', 'بليز', 'إذا سمحت'];
  return {
    language: 'ar',
    patterns: [
      pattern([want, ['', 'أن'], talk, to, nouns]),
      pattern([want, talking, to, nouns]),
      pattern([talking, to, nouns], 'whole'),
      pattern([want, nouns]),
      pattern([transfer, to, nouns]),
      pattern([nouns, please]),
    ],
    bare: pattern(
      [['موظف', 'إنسان', 'موظف بشري', 'خدمة العملاء', 'شخص حقيقي', 'ممثل خدمة العملاء']],
      'whole',
    ),
    negated: negatedBefore({
      negators: ['لا', 'لن', 'لم', 'ما', 'مش', 'مو', 'ليس', 'لست', 'مب', 'بدون', 'دون', 'بلاش'],
      chain: ['أنا', 'أن', 'هل', 'فعلا', 'حقا', 'أصلا', 'والله', ...want, ...talk],
    }),
  };
})();

// Detection -------------------------------------------------------------------------------------

const CLAUSE_BREAKS = /[\n\r.,;:!?،؛؟।॥۔…—–]+/;
const CONJUNCTIONS = normalizedSet([
  ...['but', 'however', 'though', 'although', 'instead', 'lekin', 'lakin', 'magar', 'balki'],
  ...['لكن', 'ولكن', 'بل', 'لیکن', 'مگر', 'بلکہ', 'लेकिन', 'मगर', 'बल्कि'],
]);
const COURTESY = normalizedSet([
  ...['please', 'pls', 'plz', 'now', 'asap', 'urgent', 'urgently', 'sir', 'madam', 'maam'],
  ...['bhai', 'ji', 'yaar', 'jaldi', 'प्लीज़', 'कृपया', 'پلیز', 'بليز'],
]);
/** Urdu letters that Arabic does not use; they decide whether Urdu or Arabic phrases win a tie. */
const URDU_LETTERS = /[ٹڈڑںےۓھہۂۃکگپچ]/;
// Long pasted texts are cut to their start and end, where a request would be.
const MAX_SCAN = 2000;

function clausesOf(text: string): string[][] {
  const scanned =
    text.length > MAX_SCAN * 2 ? `${text.slice(0, MAX_SCAN)}\n${text.slice(-MAX_SCAN)}` : text;
  const clauses: string[][] = [];
  for (const part of scanned.split(CLAUSE_BREAKS)) {
    let clause: string[] = [];
    for (const token of normalizeForMatching(part).split(' ')) {
      if (token === '') continue;
      if (CONJUNCTIONS.has(token)) {
        if (clause.length > 0) clauses.push(clause);
        clause = [];
      } else {
        clause.push(token);
      }
    }
    if (clause.length > 0) clauses.push(clause);
  }
  return clauses;
}

function firstRequest(clause: readonly string[], grammar: Grammar): string | undefined {
  const text = clause.join(' ');
  for (const regex of grammar.patterns) {
    for (const match of text.matchAll(regex)) {
      const start = text.slice(0, match.index).split(' ').length - 1;
      const end = start + match[0].split(' ').length;
      if (!grammar.negated(clause, start, end)) return match[0];
    }
  }
  return undefined;
}

/** Is this message an explicit request to talk to a person? Deterministic; no provider involved. */
export function detectHumanRequest(text: string): HumanRequestDetection {
  const clauses = clausesOf(text);
  if (clauses.length === 0) return { requested: false };
  const arabicScript = URDU_LETTERS.test(text) ? [urdu, arabic] : [arabic, urdu];
  const grammars = [english, hinglish, romanUrdu, hindi, ...arabicScript];

  for (const clause of clauses) {
    for (const grammar of grammars) {
      const phrase = firstRequest(clause, grammar);
      if (phrase) return { requested: true, phrase, language: grammar.language };
    }
  }

  // A message that is only a person noun ("agent", "human please", "انسان") is a request too.
  const words = clauses.flat().filter((token) => !COURTESY.has(token));
  const whole = words.filter((token, i) => token !== words[i - 1]).join(' ');
  const bare = whole === '' ? undefined : grammars.find((g) => whole.search(g.bare) !== -1);
  return bare ? { requested: true, phrase: whole, language: bare.language } : { requested: false };
}
