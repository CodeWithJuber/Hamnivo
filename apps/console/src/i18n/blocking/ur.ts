import type { BlockingTranslation } from './types';

export const blockingUr: BlockingTranslation = {
  menuItem: 'وزیٹر کو بلاک کریں…',
  menuItemSender: 'بھیجنے والے کو بلاک کریں…',
  action: 'بلاک کریں',
  actionFor: '{{name}} کو بلاک کریں',
  dialog: {
    title: '{{name}} کو بلاک کریں',
    explanation:
      'انہیں بس یہ دکھے گا کہ چیٹ ابھی دستیاب نہیں۔ براؤزر کا ڈیٹا صاف کرنے سے بلاک ختم ہو جاتا ہے؛ سائن اِن گاہک ہر ڈیوائس پر بلاک رہتے ہیں۔',
    reason: 'وجہ',
    reasonHint: 'یہ صرف آپ کی ٹیم کو، بلاک شدہ صفحے پر نظر آتی ہے۔',
    reasonMissing: 'لکھیں کہ آپ انہیں کیوں بلاک کر رہے ہیں۔',
    duration: 'کتنی دیر کے لیے',
    closeChat: 'یہ چیٹ بھی بند کریں',
    submit: 'وزیٹر کو بلاک کریں',
    done: '{{name}} بلاک ہو گئے۔',
    doneClosed: '{{name}} بلاک ہو گئے، اور چیٹ بند ہو گئی۔',
    /** A sender on email, WhatsApp or Telegram. */
    sender: {
      explanation:
        'ان کے پیغامات آتے رہیں گے، لیکن ہر گفتگو بغیر جواب کے خود بخود بند ہو جائے گی۔ انہیں بتایا نہیں جاتا۔ بلاک صرف اس چینل پر اسی پتے پر لاگو ہوتا ہے۔',
      closeChat: 'یہ گفتگو بھی بند کریں',
      submit: 'بھیجنے والے کو بلاک کریں',
      doneClosed: '{{name}} بلاک ہو گئے، اور گفتگو بند ہو گئی۔',
    },
  },
  durations: {
    day: '24 گھنٹے',
    week: '7 دن',
    month: '30 دن',
    always: 'ان بلاک ہونے تک',
  },
  durationHints: {
    until: '{{time}} تک',
    never: 'جب تک آپ کی ٹیم کا کوئی انہیں ان بلاک نہ کرے',
  },
  page: {
    link: 'بلاک شدہ',
    /** An anonymous visitor, by the short code that tells them apart. */
    anonymous: 'وزیٹر {{code}}',
    /** After a sender's address, which comes first in every language: "amina@… on Email". */
    senderOn: '{{channel}} پر',
    /** A sender with no address (Telegram). */
    senderNoAddress: '{{channel}} پر بھیجنے والے',
    title: 'بلاک شدہ وزیٹر',
    description:
      'جو وزیٹر آپ کے برانڈز سے چیٹ نہیں کر سکتے، انہیں کیوں اور کب تک بلاک کیا گیا۔ یہاں ان بلاک کریں تو وہ فوراً پھر چیٹ کر سکتے ہیں۔',
    guide: 'بلاک کرنا کیسے کام کرتا ہے',
    back: 'ان باکس پر واپس جائیں',
    loading: 'بلاک شدہ وزیٹر لوڈ ہو رہے ہیں',
    table: 'بلاک شدہ وزیٹر، نئے پہلے',
    show: 'دکھائیں',
    filters: {
      active: 'فعال',
      all: 'سب (پچھلے 90 دن)',
    },
    brand: 'برانڈ',
    allBrands: 'تمام برانڈز',
    columns: {
      who: 'کون',
      reason: 'وجہ',
      by: 'کس نے بلاک کیا',
      when: 'کب',
      expires: 'ختم ہونے کا وقت',
      actions: 'کارروائیاں',
    },
    signedIn: 'سائن اِن',
    formerStaff: 'کوئی جو اب ٹیم میں نہیں',
    standing: {
      never: 'ان بلاک ہونے تک',
      lifted: '{{time}} ان بلاک ہوا',
      liftedBy: '{{name}} نے ان بلاک کیا، {{time}}',
      expired: '{{time}} ختم ہوا',
    },
    openChat: 'چیٹ کھولیں',
    openChatFor: '{{name}} کے ساتھ چیٹ کھولیں',
    unblock: 'ان بلاک کریں',
    unblockFor: '{{name}} کو ان بلاک کریں',
    confirm: {
      title: '{{name}} کو ان بلاک کریں؟',
      body: 'وہ فوراً دوبارہ چیٹ شروع کر سکتے ہیں۔ بلاک یہاں فہرست میں رہتا ہے، ان بلاک کے نشان کے ساتھ۔',
      submit: 'ان بلاک کریں',
      done: '{{name}} ان بلاک ہو گئے۔',
      failed: '{{name}} ابھی بھی بلاک ہیں۔',
    },
    empty: {
      title: 'کوئی بلاک نہیں',
      description:
        'جب کوئی چیٹ کا غلط استعمال کرے تو اسے چیٹ کے "مزید اقدامات" مینو سے یا لائیو وزیٹرز سے بلاک کریں۔',
      allTitle: 'پچھلے 90 دنوں میں کوئی بلاک نہیں',
    },
    forbidden: {
      title: 'آپ بلاک شدہ وزیٹر نہیں دیکھ سکتے',
      description:
        'آپ کا کردار وزیٹرز کو بلاک یا ان بلاک نہیں کر سکتا۔ کسی ایڈمن یا سپروائزر سے کہیں۔',
    },
  },
};
