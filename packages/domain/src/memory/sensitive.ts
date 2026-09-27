import { normalizeForMatching } from '../human-request.js';

/**
 * Deterministic checks for content that customer memory must never hold (L07). They run on the
 * proposed value and its evidence, whoever proposed it; a model's own label can only add to them.
 * Keyword lists cover English, Roman Urdu and Hinglish, Urdu, Hindi and Arabic. They are
 * deliberately cautious: a false match means something is not remembered, which is safe.
 */

/** Special categories of personal data, and secrets. */
export const SENSITIVE_CATEGORIES = [
  'health',
  'religion',
  'ethnicity',
  'sexual_orientation',
  'political_opinion',
  'credential',
  'financial_account',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

/** Text that tries to act on the system rather than describe the customer. */
export const UNTRUSTED_PATTERNS = ['authority_claim', 'instruction'] as const;
export type UntrustedPattern = (typeof UNTRUSTED_PATTERNS)[number];

export interface TextFinding {
  category: SensitiveCategory | UntrustedPattern;
  /** Which rule matched (never the matched words, which may be personal). */
  rule: string;
}

/** Secrets: never stored, whatever the consent. */
export const SECRET_CATEGORIES: readonly SensitiveCategory[] = ['credential', 'financial_account'];

const KEYWORDS: Record<SensitiveCategory | UntrustedPattern, readonly string[]> = {
  health: [
    'health condition',
    'medical',
    'medicine',
    'medicines',
    'medication',
    'medications',
    'prescription',
    'diagnosis',
    'diagnosed',
    'disease',
    'illness',
    'allergy',
    'allergies',
    'allergic',
    'diabetes',
    'diabetic',
    'asthma',
    'cancer',
    'hiv',
    'pregnant',
    'pregnancy',
    'disability',
    'disabled',
    'wheelchair',
    'blind',
    'deaf',
    'depression',
    'depressed',
    'anxiety',
    'mental health',
    'therapy',
    'therapist',
    'psychiatrist',
    'psychiatric',
    'surgery',
    'insulin',
    'blood pressure',
    'heart condition',
    'epilepsy',
    'autism',
    'adhd',
    'dementia',
    'chemotherapy',
    'dialysis',
    'hepatitis',
    'bimari',
    'beemari',
    'bimar',
    'beemar',
    'dawai',
    'ilaj',
    'marz',
    'mareez',
    'hamila',
    'بیماری',
    'بیمار',
    'دوائی',
    'دوا',
    'علاج',
    'مریض',
    'ذیابیطس',
    'حاملہ',
    'معذور',
    'ڈپریشن',
    'الرجی',
    'बीमारी',
    'बीमार',
    'दवा',
    'दवाई',
    'इलाज',
    'मरीज',
    'मधुमेह',
    'डायबिटीज',
    'गर्भवती',
    'विकलांग',
    'डिप्रेशन',
    'एलर्जी',
    'مرض',
    'مريض',
    'دواء',
    'سكري',
    'حامل',
    'إعاقة',
    'معاق',
    'اكتئاب',
    'حساسية',
  ],
  religion: [
    'religion',
    'religious',
    'muslim',
    'christian',
    'hindu',
    'sikh',
    'jewish',
    'jew',
    'buddhist',
    'atheist',
    'agnostic',
    'catholic',
    'protestant',
    'shia',
    'sunni',
    'ahmadi',
    'church',
    'mosque',
    'temple',
    'synagogue',
    'gurdwara',
    'prayer',
    'prayers',
    'praying',
    'pray',
    'fasting',
    'halal',
    'kosher',
    'namaz',
    'roza',
    'masjid',
    'mandir',
    'mazhab',
    'mazhabi',
    'dharm',
    'dharam',
    'ibadat',
    'مذہب',
    'مذہبی',
    'مسلمان',
    'عیسائی',
    'ہندو',
    'سکھ',
    'یہودی',
    'نماز',
    'روزہ',
    'مسجد',
    'مندر',
    'عبادت',
    'حلال',
    'धर्म',
    'धार्मिक',
    'मुस्लिम',
    'मुसलमान',
    'ईसाई',
    'हिंदू',
    'हिन्दू',
    'सिख',
    'यहूदी',
    'नमाज',
    'रोजा',
    'मस्जिद',
    'मंदिर',
    'गुरुद्वारा',
    'पूजा',
    // Not the bare Arabic "دين": it normalizes to the Urdu "دیں" (please give).
    'ديانة',
    'مسلم',
    'مسيحي',
    'يهودي',
    'صلاة',
    'صيام',
    'كنيسة',
    'عبادة',
  ],
  ethnicity: [
    'ethnicity',
    'ethnic',
    'race',
    'racial',
    'caste',
    'tribe',
    'tribal',
    'skin colour',
    'skin color',
    'ancestry',
    'zaat',
    'biradari',
    'baradari',
    'jaati',
    'ذات',
    'برادری',
    'نسل',
    'قومیت',
    'जाति',
    'जात',
    'नस्ल',
    'जनजाति',
    'عرق',
    'عرقي',
    'قبيلة',
  ],
  sexual_orientation: [
    'gay',
    'lesbian',
    'bisexual',
    'homosexual',
    'heterosexual',
    'queer',
    'lgbt',
    'lgbtq',
    'lgbtqia',
    'sexual orientation',
    'transgender',
    'nonbinary',
    'non binary',
    'intersex',
    'ہم جنس پرست',
    'خواجہ سرا',
    'ٹرانس جینڈر',
    'समलैंगिक',
    'ट्रांसजेंडर',
    'किन्नर',
    'مثلي',
    'مثلية',
    'مثليين',
    'متحول جنسيا',
  ],
  political_opinion: [
    'politics',
    'political',
    'vote',
    'voted',
    'votes',
    'voting',
    'voter',
    'election',
    'elections',
    'party member',
    'siyasat',
    'siyasi',
    'سیاست',
    'سیاسی',
    'ووٹ',
    'انتخابات',
    'राजनीति',
    'राजनीतिक',
    'वोट',
    'चुनाव',
    'मतदान',
    'سياسة',
    'سياسي',
    'تصويت',
    'حزب',
  ],
  credential: [
    'password',
    'passwords',
    'passcode',
    'passphrase',
    'pass word',
    'pwd',
    'pin',
    'pin code',
    'pin number',
    'otp',
    'one time password',
    'one time code',
    'security question',
    'security answer',
    'login code',
    'verification code',
    '2fa',
    'secret code',
    'cvv',
    'cvc',
    'security code',
    'khufia code',
    'پاس ورڈ',
    'پاسورڈ',
    'خفیہ کوڈ',
    'پن کوڈ',
    'خفیہ نمبر',
    'पासवर्ड',
    'पिन',
    'ओटीपी',
    'गुप्त कोड',
    'पिन कोड',
    'كلمة المرور',
    'كلمة مرور',
    'كلمة السر',
    'رمز التحقق',
    'الرقم السري',
    'رمز سري',
  ],
  // Digits and account numbers are checked separately (see ACCOUNT_WORDS and the number rules).
  financial_account: ['iban', 'credit card number', 'debit card number', 'bank account number'],
  authority_claim: [
    'admin',
    'administrator',
    'superuser',
    'super user',
    'moderator',
    'root access',
    'permission',
    'permissions',
    'authorized',
    'authorised',
    'authorization',
    'authorisation',
    'entitled',
    'entitlement',
    'exempt',
    'exemption',
    'override',
    'bypass',
    'waive',
    'waived',
    'waiver',
    'vip',
    'staff discount',
    'employee discount',
    'approve refunds',
    'refund approval',
    'lifetime discount',
    'manager approval',
    'ijazat',
    'ikhtiyar',
    'manzoori',
    'اجازت',
    'اختیار',
    'منظوری',
    'ایڈمن',
    'अनुमति',
    'अधिकार',
    'मंजूरी',
    'मंज़ूरी',
    'एडमिन',
    'صلاحية',
    'صلاحيات',
    'إذن',
    'تفويض',
    'مسؤول النظام',
    'مدير النظام',
  ],
  instruction: [
    'ignore previous instructions',
    'ignore all instructions',
    'ignore all previous',
    'ignore the above',
    'ignore your instructions',
    'ignore your rules',
    'disregard previous',
    'disregard all',
    'disregard the above',
    'system prompt',
    'you are now',
    'act as an',
    'act as a',
    'act as the',
    'act as my',
    'pretend to be',
    'pretend you are',
    'new instructions',
    'developer mode',
    'jailbreak',
    'do anything now',
    'override your',
    'reveal your prompt',
    'reveal the prompt',
    'from now on you must',
    'from now on you will',
  ],
};

/** Words that make a following run of digits an account or card number. */
const ACCOUNT_WORDS = [
  'account',
  'acct',
  'iban',
  'routing',
  'sort code',
  'swift',
  'bic',
  'card',
  'bank',
  'khata',
  'اکاؤنٹ',
  'کھاتہ',
  'بینک',
  'खाता',
  'अकाउंट',
  'बैंक',
  'حساب',
  'بطاقة',
  'بنك',
];

const ARABIC_SCRIPT = /[\u0600-\u06ff]/;
/** Arabic attaches the article and some prepositions to the word ("والصلاة", "بالبطاقة"). */
const ARABIC_PREFIXES = '(?:وال|بال|لل|ال|و|ب|ل|ف)?';
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One pattern per list: whole normalized words, longest alternatives first. */
function compile(words: readonly string[]): RegExp | null {
  const plain: string[] = [];
  const arabic: string[] = [];
  for (const word of new Set(words.map(normalizeForMatching).filter(Boolean))) {
    (ARABIC_SCRIPT.test(word) ? arabic : plain).push(escapeRegExp(word));
  }
  const byLength = (a: string, b: string) => b.length - a.length;
  const parts = [
    ...(plain.length ? [`(?:${plain.sort(byLength).join('|')})`] : []),
    ...(arabic.length ? [`${ARABIC_PREFIXES}(?:${arabic.sort(byLength).join('|')})`] : []),
  ];
  return parts.length ? new RegExp(`(?<![^ ])(?:${parts.join('|')})(?![^ ])`, 'u') : null;
}

const PATTERNS = Object.fromEntries(
  Object.entries(KEYWORDS).map(([category, words]) => [category, compile(words)]),
) as Record<SensitiveCategory | UntrustedPattern, RegExp | null>;

const ACCOUNT_NUMBER = new RegExp(
  `${compile(ACCOUNT_WORDS)?.source ?? '$^'}[^0-9]{0,24}[0-9](?: ?[0-9]){5,}`,
  'u',
);
const NATIVE_DIGITS = /[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f]/g;
const DIGIT_RUNS = /\d(?:[ .-]?\d){11,}/g;
/** Country, check digits and an account part that is mostly digits (checked after matching). */
const IBAN = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])/g;
const PROMPT_MARKUP =
  /<\s*\/?\s*(?:system|assistant|instructions?|prompt)\b|\[\/?(?:inst|system)\]/i;

function asciiDigits(text: string): string {
  return text.replace(NATIVE_DIGITS, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const zero = code >= 0x0966 ? 0x0966 : code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - zero);
  });
}

/** Card numbers pass the Luhn check. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Everything in `text` that memory must refuse, as categories and rule names. */
export function inspectMemoryText(text: string): TextFinding[] {
  const findings: TextFinding[] = [];
  const add = (category: TextFinding['category'], rule: string) => {
    if (!findings.some((f) => f.category === category && f.rule === rule)) {
      findings.push({ category, rule });
    }
  };
  const normalized = normalizeForMatching(text);
  for (const [category, pattern] of Object.entries(PATTERNS)) {
    if (pattern?.test(normalized)) add(category as TextFinding['category'], 'keyword');
  }
  if (ACCOUNT_NUMBER.test(normalized)) add('financial_account', 'account_number');
  const raw = asciiDigits(text);
  for (const run of raw.match(DIGIT_RUNS) ?? []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      add('financial_account', 'card_number');
    }
    add('financial_account', 'long_number');
  }
  for (const match of raw.match(IBAN) ?? []) {
    if (match.slice(4).replace(/\D/g, '').length >= 10) add('financial_account', 'iban');
  }
  if (PROMPT_MARKUP.test(text)) add('instruction', 'markup');
  return findings;
}

/** Plain-language names, for explanations shown to people. */
export const CATEGORY_NAMES: Record<SensitiveCategory | UntrustedPattern, string> = {
  health: 'health information',
  religion: 'religious beliefs',
  ethnicity: 'ethnic origin',
  sexual_orientation: 'sexual orientation or gender identity',
  political_opinion: 'political views',
  credential: 'a password or security code',
  financial_account: 'an account or card number',
  authority_claim: 'a role, permission or entitlement',
  instruction: 'an instruction to the assistant',
};
