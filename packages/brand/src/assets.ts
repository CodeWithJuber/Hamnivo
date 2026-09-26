/**
 * Brand asset and product-visual manifest. Alt text exists for every supported UI locale.
 * Arabic, Hindi and Urdu strings are initial translations awaiting native-speaker review
 * (blueprint U14); `reviewStatus` records that honestly.
 */

export type Locale = 'en' | 'ar' | 'hi' | 'ur';

export interface ProductVisual {
  id: 'hero' | 'teamwork' | 'memory' | 'integrations' | 'multilingual' | 'commerce';
  /** Source PNG in packages/brand/source (transparent unless noted). */
  source: string;
  width: number;
  height: number;
  /** Background the illustration was composed for. */
  background: 'transparent' | 'dark';
  caption: Record<Locale, string>;
  alt: Record<Locale, string>;
  reviewStatus: 'reviewed' | 'pending_native_review';
}

export const productVisuals: readonly ProductVisual[] = [
  {
    id: 'hero',
    source: 'hamnivo-hero.png',
    width: 1536,
    height: 1024,
    background: 'dark',
    caption: {
      en: 'Connected conversations',
      ar: 'محادثات متصلة',
      hi: 'जुड़ी हुई बातचीत',
      ur: 'جڑی ہوئی گفتگو',
    },
    alt: {
      en: 'A chat window between a customer card and the Hamnivo mark, joined by a flowing ink and coral ribbon.',
      ar: 'نافذة محادثة بين بطاقة عميل وشعار Hamnivo، يربط بينها شريط متدفق باللونين الداكن والمرجاني.',
      hi: 'ग्राहक कार्ड और Hamnivo चिह्न के बीच एक चैट विंडो, जिन्हें गहरे और कोरल रंग का बहता हुआ रिबन जोड़ता है।',
      ur: 'کسٹمر کارڈ اور Hamnivo نشان کے درمیان ایک چیٹ ونڈو، جنہیں گہرے اور مرجانی رنگ کا بہتا ہوا ربن جوڑتا ہے۔',
    },
    reviewStatus: 'pending_native_review',
  },
  {
    id: 'teamwork',
    source: 'hamnivo-teamwork.png',
    width: 1254,
    height: 1254,
    background: 'transparent',
    caption: {
      en: 'Coordinated participants',
      ar: 'مشاركون منسّقون',
      hi: 'तालमेल वाले प्रतिभागी',
      ur: 'ہم آہنگ شرکاء',
    },
    alt: {
      en: "A person's card with an approved reply in the centre, flanked by two Hamnivo AI panels on a shared coral ring.",
      ar: 'بطاقة شخص في المنتصف مع رد معتمد، وعلى جانبيها لوحتان للذكاء الاصطناعي من Hamnivo على حلقة مرجانية مشتركة.',
      hi: 'बीच में स्वीकृत जवाब के साथ एक व्यक्ति का कार्ड, जिसके दोनों ओर साझा कोरल घेरे पर Hamnivo AI के दो पैनल हैं।',
      ur: 'درمیان میں منظور شدہ جواب کے ساتھ ایک شخص کا کارڈ، جس کے دونوں طرف مشترکہ مرجانی دائرے پر Hamnivo AI کے دو پینل ہیں۔',
    },
    reviewStatus: 'pending_native_review',
  },
  {
    id: 'memory',
    source: 'hamnivo-memory.png',
    width: 1254,
    height: 1254,
    background: 'transparent',
    caption: {
      en: 'Context and correction',
      ar: 'السياق والتصحيح',
      hi: 'संदर्भ और सुधार',
      ur: 'سیاق اور تصحیح',
    },
    alt: {
      en: 'An archive tray of document cards linked by a coral timeline; one card is being updated and the last one is verified.',
      ar: 'درج أرشيف لبطاقات مستندات يربطها خط زمني مرجاني؛ إحدى البطاقات قيد التحديث والأخيرة موثّقة.',
      hi: 'दस्तावेज़ कार्डों की एक संग्रह ट्रे जिन्हें कोरल समयरेखा जोड़ती है; एक कार्ड अपडेट हो रहा है और आख़िरी कार्ड सत्यापित है।',
      ur: 'دستاویزی کارڈز کی ایک آرکائیو ٹرے جنہیں مرجانی ٹائم لائن جوڑتی ہے؛ ایک کارڈ اپ ڈیٹ ہو رہا ہے اور آخری کارڈ تصدیق شدہ ہے۔',
    },
    reviewStatus: 'pending_native_review',
  },
  {
    id: 'integrations',
    source: 'hamnivo-integrations.png',
    width: 1254,
    height: 1254,
    background: 'transparent',
    caption: {
      en: 'Connected applications',
      ar: 'تطبيقات متصلة',
      hi: 'जुड़े हुए ऐप्लिकेशन',
      ur: 'جڑی ہوئی ایپلیکیشنز',
    },
    alt: {
      en: 'A central Hamnivo hub connected by coral cables to a website, a mobile app, an API code block and a server.',
      ar: 'مركز Hamnivo متصل بكابلات مرجانية بموقع ويب وتطبيق جوال وكتلة شيفرة لواجهة برمجة التطبيقات وخادم.',
      hi: 'एक केंद्रीय Hamnivo हब, जो कोरल केबलों से एक वेबसाइट, मोबाइल ऐप, API कोड ब्लॉक और सर्वर से जुड़ा है।',
      ur: 'ایک مرکزی Hamnivo حب جو مرجانی کیبلز کے ذریعے ویب سائٹ، موبائل ایپ، API کوڈ بلاک اور سرور سے جڑا ہے۔',
    },
    reviewStatus: 'pending_native_review',
  },
  {
    id: 'multilingual',
    source: 'hamnivo-multilingual.png',
    width: 1254,
    height: 1254,
    background: 'transparent',
    caption: {
      en: 'English, Hindi, Arabic and Urdu',
      ar: 'الإنجليزية والهندية والعربية والأردية',
      hi: 'अंग्रेज़ी, हिंदी, अरबी और उर्दू',
      ur: 'انگریزی، ہندی، عربی اور اردو',
    },
    alt: {
      en: 'Four speech bubbles saying Hello, Marhaba, Namaste and Salam around the Hamnivo hub, joined by a coral ring.',
      ar: 'أربع فقاعات حوار بالتحيات Hello ومرحبا ونमस्ते وسلام حول مركز Hamnivo، تربطها حلقة مرجانية.',
      hi: 'Hamnivo हब के चारों ओर चार संवाद-बुलबुले — Hello, मरहबा, नमस्ते और सलाम — जिन्हें कोरल घेरा जोड़ता है।',
      ur: 'Hamnivo حب کے گرد چار مکالماتی غبارے — Hello، مرحبا، نمستے اور سلام — جنہیں مرجانی دائرہ جوڑتا ہے۔',
    },
    reviewStatus: 'pending_native_review',
  },
  {
    id: 'commerce',
    source: 'hamnivo-commerce.png',
    width: 1254,
    height: 1254,
    background: 'transparent',
    caption: {
      en: 'Review before confirmation',
      ar: 'المراجعة قبل التأكيد',
      hi: 'पुष्टि से पहले समीक्षा',
      ur: 'تصدیق سے پہلے جائزہ',
    },
    alt: {
      en: "An order summary card, a coral 'next' step, a wrapped parcel and a phone showing an approval check mark.",
      ar: 'بطاقة ملخص طلب، وخطوة تالية باللون المرجاني، وطرد مغلّف، وهاتف يعرض علامة موافقة.',
      hi: "ऑर्डर सारांश कार्ड, कोरल रंग का 'अगला' चरण, एक पैक किया हुआ पार्सल और स्वीकृति का निशान दिखाता फ़ोन।",
      ur: "آرڈر خلاصہ کارڈ، مرجانی 'اگلا' مرحلہ، ایک پیک شدہ پارسل اور منظوری کا نشان دکھاتا فون۔",
    },
    reviewStatus: 'pending_native_review',
  },
];

/** Vector brand assets generated by scripts/vectorize.ts and scripts/icons.ts (in assets/). */
export const brandAssets = {
  mark: 'hamnivo-mark.svg',
  markOnDark: 'hamnivo-mark-on-dark.svg',
  markMono: 'hamnivo-mark-mono.svg',
  lockup: 'hamnivo-lockup.svg',
  lockupOnDark: 'hamnivo-lockup-on-dark.svg',
  wordmark: 'hamnivo-wordmark.svg',
  favicon: 'favicon.svg',
  faviconIco: 'favicon.ico',
  appleTouchIcon: 'apple-touch-icon.png',
  icon192: 'icon-192.png',
  icon512: 'icon-512.png',
  maskable512: 'icon-maskable-512.png',
  ogImage: 'og-image.png',
  manifest: 'site.webmanifest',
} as const;
