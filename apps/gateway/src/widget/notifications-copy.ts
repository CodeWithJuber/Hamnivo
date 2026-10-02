/**
 * Customer emails and the unsubscribe page (W25), in the chat's four languages. Emails never
 * carry a reply's text: they say a reply waits and where to read it. Translations await native
 * review, like the rest of the customer copy.
 */
export type NotifyLocale = 'en' | 'ar' | 'hi' | 'ur';

export interface NotifyCopy {
  transcriptSubject: (brand: string) => string;
  transcriptIntro: (brand: string) => string;
  replySubject: (brand: string) => string;
  replyBody: (brand: string) => string;
  openChat: string;
  why: (brand: string) => string;
  stop: string;
  you: string;
  supportAgent: string;
  aiAssistant: string;
  file: string;
  place: string;
  contact: string;
  deleted: string;
  reacted: string;
  pageTitle: string;
  confirmQuestion: { transcript: string; reply_waiting: string; all: string };
  confirmButton: string;
  done: { transcript: string; reply_waiting: string; all: string };
  changeLater: string;
  invalid: string;
}

export const NOTIFY_COPY: Record<NotifyLocale, NotifyCopy> = {
  en: {
    transcriptSubject: (brand) => `Your conversation with ${brand}`,
    transcriptIntro: (brand) => `Here is your conversation with ${brand}, as it was closed.`,
    replySubject: (brand) => `${brand} replied to you`,
    replyBody: (brand) =>
      `You have a new reply in your chat with ${brand}. For your privacy, it is not in this email.`,
    openChat: 'Read it in the chat on the website:',
    why: (brand) => `You get this email because you turned it on in the chat with ${brand}.`,
    stop: 'Stop these emails:',
    you: 'You',
    supportAgent: 'Support agent',
    aiAssistant: 'AI assistant',
    file: 'File',
    place: 'Place',
    contact: 'Contact',
    deleted: 'Message deleted',
    reacted: 'Reaction',
    pageTitle: 'Email preferences',
    confirmQuestion: {
      transcript: 'Stop emailing you transcripts of your conversations?',
      reply_waiting: 'Stop emailing you when a reply is waiting?',
      all: 'Stop all emails about your conversations?',
    },
    confirmButton: 'Yes, stop these emails',
    done: {
      transcript: 'You won’t get transcripts by email any more.',
      reply_waiting: 'You won’t get emails about waiting replies any more.',
      all: 'You won’t get emails about your conversations any more.',
    },
    changeLater: 'You can turn them on again in the chat.',
    invalid: 'This link isn’t valid. It may be incomplete; try copying it again.',
  },
  ar: {
    transcriptSubject: (brand) => `محادثتك مع ${brand}`,
    transcriptIntro: (brand) => `إليك محادثتك مع ${brand} كما أُغلقت.`,
    replySubject: (brand) => `ردّ ${brand} عليك`,
    replyBody: (brand) =>
      `لديك رد جديد في محادثتك مع ${brand}. حفاظًا على خصوصيتك، لا يظهر نص الرد في هذه الرسالة.`,
    openChat: 'اقرأه في المحادثة على الموقع:',
    why: (brand) => `تصلك هذه الرسالة لأنك فعّلتها في المحادثة مع ${brand}.`,
    stop: 'إيقاف هذه الرسائل:',
    you: 'أنت',
    supportAgent: 'موظف الدعم',
    aiAssistant: 'المساعد الذكي',
    file: 'ملف',
    place: 'مكان',
    contact: 'جهة اتصال',
    deleted: 'رسالة محذوفة',
    reacted: 'تفاعل',
    pageTitle: 'تفضيلات البريد الإلكتروني',
    confirmQuestion: {
      transcript: 'هل تريد إيقاف إرسال نصوص محادثاتك بالبريد الإلكتروني؟',
      reply_waiting: 'هل تريد إيقاف إشعارك بالبريد عندما ينتظرك رد؟',
      all: 'هل تريد إيقاف كل الرسائل المتعلقة بمحادثاتك؟',
    },
    confirmButton: 'نعم، أوقف هذه الرسائل',
    done: {
      transcript: 'لن تصلك نصوص المحادثات بالبريد بعد الآن.',
      reply_waiting: 'لن تصلك رسائل عن الردود المنتظرة بعد الآن.',
      all: 'لن تصلك رسائل عن محادثاتك بعد الآن.',
    },
    changeLater: 'يمكنك تفعيلها مجددًا من المحادثة.',
    invalid: 'هذا الرابط غير صالح. ربما لم يُنسخ كاملًا، فجرّب نسخه مرة أخرى.',
  },
  hi: {
    transcriptSubject: (brand) => `${brand} के साथ आपकी बातचीत`,
    transcriptIntro: (brand) => `${brand} के साथ आपकी बातचीत, जैसी वह बंद हुई।`,
    replySubject: (brand) => `${brand} ने आपको जवाब दिया`,
    replyBody: (brand) =>
      `${brand} के साथ आपकी चैट में एक नया जवाब है। आपकी निजता के लिए उसका पाठ इस ईमेल में नहीं है।`,
    openChat: 'वेबसाइट पर चैट में पढ़ें:',
    why: (brand) => `आपको यह ईमेल इसलिए मिला क्योंकि आपने ${brand} की चैट में इसे चालू किया था।`,
    stop: 'ये ईमेल बंद करें:',
    you: 'आप',
    supportAgent: 'सपोर्ट एजेंट',
    aiAssistant: 'एआई सहायक',
    file: 'फ़ाइल',
    place: 'जगह',
    contact: 'संपर्क',
    deleted: 'संदेश हटाया गया',
    reacted: 'प्रतिक्रिया',
    pageTitle: 'ईमेल पसंद',
    confirmQuestion: {
      transcript: 'क्या बातचीत के ट्रांसक्रिप्ट ईमेल से भेजना बंद करें?',
      reply_waiting: 'क्या जवाब इंतज़ार में होने पर ईमेल भेजना बंद करें?',
      all: 'क्या आपकी बातचीत के बारे में सभी ईमेल बंद करें?',
    },
    confirmButton: 'हाँ, ये ईमेल बंद करें',
    done: {
      transcript: 'अब आपको ईमेल से ट्रांसक्रिप्ट नहीं मिलेंगे।',
      reply_waiting: 'अब आपको इंतज़ार कर रहे जवाबों के ईमेल नहीं मिलेंगे।',
      all: 'अब आपको अपनी बातचीत के बारे में ईमेल नहीं मिलेंगे।',
    },
    changeLater: 'आप इन्हें चैट में फिर से चालू कर सकते हैं।',
    invalid: 'यह लिंक मान्य नहीं है। शायद यह अधूरा है; इसे फिर से कॉपी करके देखें।',
  },
  ur: {
    transcriptSubject: (brand) => `${brand} کے ساتھ آپ کی گفتگو`,
    transcriptIntro: (brand) => `${brand} کے ساتھ آپ کی گفتگو، جیسے وہ بند ہوئی۔`,
    replySubject: (brand) => `${brand} نے آپ کو جواب دیا`,
    replyBody: (brand) =>
      `${brand} کے ساتھ آپ کی چیٹ میں ایک نیا جواب ہے۔ آپ کی رازداری کے لیے اس کا متن اس ای میل میں نہیں ہے۔`,
    openChat: 'ویب سائٹ پر چیٹ میں پڑھیں:',
    why: (brand) => `آپ کو یہ ای میل اس لیے ملی کیونکہ آپ نے ${brand} کی چیٹ میں اسے آن کیا تھا۔`,
    stop: 'یہ ای میلز بند کریں:',
    you: 'آپ',
    supportAgent: 'سپورٹ ایجنٹ',
    aiAssistant: 'اے آئی اسسٹنٹ',
    file: 'فائل',
    place: 'جگہ',
    contact: 'رابطہ',
    deleted: 'پیغام حذف کر دیا گیا',
    reacted: 'ردعمل',
    pageTitle: 'ای میل کی ترجیحات',
    confirmQuestion: {
      transcript: 'کیا گفتگو کے ٹرانسکرپٹ ای میل سے بھیجنا بند کر دیں؟',
      reply_waiting: 'کیا جواب منتظر ہونے پر ای میل بھیجنا بند کر دیں؟',
      all: 'کیا آپ کی گفتگو کے بارے میں تمام ای میلز بند کر دیں؟',
    },
    confirmButton: 'جی ہاں، یہ ای میلز بند کریں',
    done: {
      transcript: 'اب آپ کو ای میل پر ٹرانسکرپٹ نہیں ملیں گے۔',
      reply_waiting: 'اب آپ کو منتظر جوابات کی ای میلز نہیں ملیں گی۔',
      all: 'اب آپ کو اپنی گفتگو کے بارے میں ای میلز نہیں ملیں گی۔',
    },
    changeLater: 'آپ انہیں چیٹ میں دوبارہ آن کر سکتے ہیں۔',
    invalid: 'یہ لنک درست نہیں ہے۔ شاید یہ ادھورا ہے؛ اسے دوبارہ کاپی کر کے دیکھیں۔',
  },
};

export const notifyLocale = (locale: string | null | undefined): NotifyLocale => {
  const base = locale?.toLowerCase().split('-')[0];
  return base === 'ar' || base === 'hi' || base === 'ur' ? base : 'en';
};
