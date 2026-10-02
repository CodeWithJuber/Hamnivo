/**
 * Where the payment provider sends the customer back (C06). Coming back proves nothing about the
 * payment: this page only tells the chat to ask the server, which asks the provider. It shows no
 * order details and trusts nothing in its address beyond which purchase to look at.
 */
const COPY = {
  en: {
    success: [
      'Payment step finished',
      'Go back to the chat. It shows the payment as paid only when the provider confirms it.',
    ],
    cancel: [
      'Payment not finished',
      'Nothing was charged. Go back to the chat to review your order.',
    ],
  },
  ar: {
    success: [
      'انتهت خطوة الدفع',
      'عد إلى المحادثة. تظهر الدفعة مدفوعة فقط عندما يؤكدها مزوّد الدفع.',
    ],
    cancel: ['لم يكتمل الدفع', 'لم يُخصم أي مبلغ. عد إلى المحادثة لمراجعة طلبك.'],
  },
  hi: {
    success: [
      'भुगतान का चरण पूरा हुआ',
      'चैट पर लौटें। प्रदाता की पुष्टि के बाद ही भुगतान को पूरा दिखाया जाएगा।',
    ],
    cancel: ['भुगतान पूरा नहीं हुआ', 'कोई पैसा नहीं कटा। अपना ऑर्डर देखने के लिए चैट पर लौटें।'],
  },
  ur: {
    success: [
      'ادائیگی کا مرحلہ مکمل ہوا',
      'چیٹ پر واپس جائیں۔ فراہم کنندہ کی تصدیق کے بعد ہی ادائیگی مکمل دکھائی جائے گی۔',
    ],
    cancel: [
      'ادائیگی مکمل نہیں ہوئی',
      'کوئی رقم نہیں کٹی۔ اپنا آرڈر دیکھنے کے لیے چیٹ پر واپس جائیں۔',
    ],
  },
} as const;

const query = new URLSearchParams(window.location.search);
const result = query.get('result') === 'cancel' ? 'cancel' : 'success';
const purchase = query.get('purchase') ?? '';
const language = (navigator.language.split('-')[0] ?? 'en') as keyof typeof COPY;
const copy = (COPY[language] ?? COPY.en)[result];
document.documentElement.lang = COPY[language] ? language : 'en';
document.documentElement.dir = language === 'ar' || language === 'ur' ? 'rtl' : 'ltr';
document.title = copy[0];
const title = document.getElementById('title');
const body = document.getElementById('body');
if (title) title.textContent = copy[0];
if (body) body.textContent = copy[1];

// The chat (when it can hear this browser tab) checks the purchase with the server at once.
if (/^pur_[0-9a-z]{26}$/.test(purchase) && typeof BroadcastChannel !== 'undefined') {
  const channel = new BroadcastChannel('hamnivo-checkout');
  channel.postMessage({ type: 'checkout-return', purchase, result });
  channel.close();
}
