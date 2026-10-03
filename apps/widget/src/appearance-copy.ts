/**
 * The chat's own words for the brand's look (W03): the rating asked for when a chat is closed
 * and the privacy link. In the four launch languages; translations await native review, like the
 * rest of the widget.
 */
export const APPEARANCE_COPY = {
  en: {
    csat: {
      title: 'How was this chat?',
      hint: 'Choose from 1 (poor) to 5 (great).',
      star: '{{count}} out of 5',
      commentLabel: 'Anything to add? (optional)',
      send: 'Send rating',
      chooseFirst: 'Choose a rating first.',
      thanks: 'Thank you for your feedback.',
      failed: 'The rating was not sent. Please try again.',
    },
    privacy: 'Privacy policy',
  },
  ar: {
    csat: {
      title: 'كيف كانت هذه المحادثة؟',
      hint: 'اختر من 1 (ضعيفة) إلى 5 (ممتازة).',
      star: '{{count}} من 5',
      commentLabel: 'هل تريد إضافة شيء؟ (اختياري)',
      send: 'إرسال التقييم',
      chooseFirst: 'اختر تقييمًا أولًا.',
      thanks: 'شكرًا لك على ملاحظاتك.',
      failed: 'لم يُرسل التقييم. حاول مرة أخرى.',
    },
    privacy: 'سياسة الخصوصية',
  },
  hi: {
    csat: {
      title: 'यह बातचीत कैसी रही?',
      hint: '1 (खराब) से 5 (बहुत अच्छी) तक चुनें।',
      star: '5 में से {{count}}',
      commentLabel: 'कुछ और जोड़ना है? (वैकल्पिक)',
      send: 'रेटिंग भेजें',
      chooseFirst: 'पहले एक रेटिंग चुनें।',
      thanks: 'आपकी प्रतिक्रिया के लिए धन्यवाद।',
      failed: 'रेटिंग नहीं भेजी जा सकी। कृपया फिर से कोशिश करें।',
    },
    privacy: 'गोपनीयता नीति',
  },
  ur: {
    csat: {
      title: 'یہ گفتگو کیسی رہی؟',
      hint: '1 (کمزور) سے 5 (بہترین) تک چنیں۔',
      star: '5 میں سے {{count}}',
      commentLabel: 'کچھ اور کہنا ہے؟ (اختیاری)',
      send: 'ریٹنگ بھیجیں',
      chooseFirst: 'پہلے ایک ریٹنگ چنیں۔',
      thanks: 'آپ کی رائے کا شکریہ۔',
      failed: 'ریٹنگ نہیں بھیجی جا سکی۔ براہ کرم دوبارہ کوشش کریں۔',
    },
    privacy: 'پرائیویسی پالیسی',
  },
} as const;
