import type { NotifyLocale } from './notifications-copy.js';

/**
 * Emails and pages for tickets from the contact form (W11, H19), in each language; translations
 * await native review. The confirmation never repeats what the customer wrote: anyone can type
 * someone else's address into a form, so nothing but a question reaches it until they confirm.
 */
export interface TicketCopy {
  confirmSubject: (brand: string, reference: string) => string;
  confirmBody: (brand: string, reference: string) => string;
  confirmAction: string;
  notYou: (brand: string) => string;
  replySubject: (brand: string, reference: string) => string;
  replyIntro: (brand: string, reference: string) => string;
  /** Replies by email arrive with the email channel; until then, the chat is the way back. */
  noEmailReplies: string;
  pageTitle: string;
  pageQuestion: (brand: string, reference: string) => string;
  pageButton: string;
  confirmed: (brand: string) => string;
  invalid: string;
  stop: string;
}

export const TICKET_COPY: Record<NotifyLocale, TicketCopy> = {
  en: {
    confirmSubject: (brand, ref) => `Confirm your email for ${brand} (${ref})`,
    confirmBody: (brand, ref) =>
      `We got your message to ${brand}. Its reference is ${ref}. To get the answer by email, confirm this address:`,
    confirmAction: 'Confirm my email:',
    notYou: (brand) =>
      `If you did not write to ${brand}, ignore this email. Nothing more will be sent to you.`,
    replySubject: (brand, ref) => `${brand} answered your message ${ref}`,
    replyIntro: (brand, ref) => `${brand} answered your message ${ref}:`,
    noEmailReplies: 'Replies to this email are not read. To write back, open the chat:',
    pageTitle: 'Confirm your email',
    pageQuestion: (brand, ref) => `Send the answers to your message ${ref} to ${brand} by email?`,
    pageButton: 'Yes, confirm my email',
    confirmed: (brand) => `Thank you. ${brand}’s answers will come to this address.`,
    invalid: 'This link isn’t valid. It may be incomplete; try copying it again.',
    stop: 'Stop these emails:',
  },
  ar: {
    confirmSubject: (brand, ref) => `أكّد بريدك الإلكتروني لدى ${brand} (${ref})`,
    confirmBody: (brand, ref) =>
      `وصلتنا رسالتك إلى ${brand}، ومرجعها ${ref}. لتصلك الإجابة بالبريد الإلكتروني، أكّد هذا العنوان:`,
    confirmAction: 'تأكيد بريدي الإلكتروني:',
    notYou: (brand) => `إن لم تراسل ${brand} فتجاهل هذه الرسالة، ولن يصلك شيء آخر.`,
    replySubject: (brand, ref) => `ردّت ${brand} على رسالتك ${ref}`,
    replyIntro: (brand, ref) => `ردّت ${brand} على رسالتك ${ref}:`,
    noEmailReplies: 'لا تُقرأ الردود على هذه الرسالة. للرد، افتح المحادثة:',
    pageTitle: 'تأكيد بريدك الإلكتروني',
    pageQuestion: (brand, ref) =>
      `هل تريد أن تصلك إجابات ${brand} عن رسالتك ${ref} بالبريد الإلكتروني؟`,
    pageButton: 'نعم، أكّد بريدي الإلكتروني',
    confirmed: (brand) => `شكرًا لك. ستصل إجابات ${brand} إلى هذا العنوان.`,
    invalid: 'هذا الرابط غير صالح. ربما نُسخ ناقصًا؛ جرّب نسخه مرة أخرى.',
    stop: 'إيقاف هذه الرسائل:',
  },
  hi: {
    confirmSubject: (brand, ref) => `${brand} के लिए अपना ईमेल पक्का करें (${ref})`,
    confirmBody: (brand, ref) =>
      `${brand} को भेजा आपका संदेश हमें मिल गया है। इसका संदर्भ ${ref} है। जवाब ईमेल पर पाने के लिए यह पता पक्का करें:`,
    confirmAction: 'मेरा ईमेल पक्का करें:',
    notYou: (brand) =>
      `अगर आपने ${brand} को नहीं लिखा, तो इस ईमेल को अनदेखा करें। आपको आगे कुछ नहीं भेजा जाएगा।`,
    replySubject: (brand, ref) => `${brand} ने आपके संदेश ${ref} का जवाब दिया`,
    replyIntro: (brand, ref) => `${brand} ने आपके संदेश ${ref} का जवाब दिया:`,
    noEmailReplies: 'इस ईमेल के जवाब पढ़े नहीं जाते। जवाब लिखने के लिए चैट खोलें:',
    pageTitle: 'अपना ईमेल पक्का करें',
    pageQuestion: (brand, ref) => `क्या ${brand} आपके संदेश ${ref} के जवाब ईमेल पर भेजे?`,
    pageButton: 'हाँ, मेरा ईमेल पक्का करें',
    confirmed: (brand) => `धन्यवाद। ${brand} के जवाब इसी पते पर आएँगे।`,
    invalid: 'यह लिंक सही नहीं है। हो सकता है यह अधूरा कॉपी हुआ हो; फिर से कॉपी करके देखें।',
    stop: 'ये ईमेल बंद करें:',
  },
  ur: {
    confirmSubject: (brand, ref) => `${brand} کے لیے اپنی ای میل کی تصدیق کریں (${ref})`,
    confirmBody: (brand, ref) =>
      `${brand} کو بھیجا گیا آپ کا پیغام ہمیں مل گیا ہے۔ اس کا حوالہ ${ref} ہے۔ جواب ای میل پر پانے کے لیے اس پتے کی تصدیق کریں:`,
    confirmAction: 'میری ای میل کی تصدیق کریں:',
    notYou: (brand) =>
      `اگر آپ نے ${brand} کو نہیں لکھا تو اس ای میل کو نظر انداز کریں۔ آپ کو مزید کچھ نہیں بھیجا جائے گا۔`,
    replySubject: (brand, ref) => `${brand} نے آپ کے پیغام ${ref} کا جواب دیا`,
    replyIntro: (brand, ref) => `${brand} نے آپ کے پیغام ${ref} کا جواب دیا:`,
    noEmailReplies: 'اس ای میل کے جوابات پڑھے نہیں جاتے۔ جواب لکھنے کے لیے چیٹ کھولیں:',
    pageTitle: 'اپنی ای میل کی تصدیق کریں',
    pageQuestion: (brand, ref) => `کیا ${brand} آپ کے پیغام ${ref} کے جوابات ای میل پر بھیجے؟`,
    pageButton: 'ہاں، میری ای میل کی تصدیق کریں',
    confirmed: (brand) => `شکریہ۔ ${brand} کے جوابات اسی پتے پر آئیں گے۔`,
    invalid: 'یہ لنک درست نہیں ہے۔ ہو سکتا ہے یہ ادھورا کاپی ہوا ہو؛ دوبارہ کاپی کر کے دیکھیں۔',
    stop: 'یہ ای میلز بند کریں:',
  },
};
