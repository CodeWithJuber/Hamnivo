import type { ChannelsTranslation } from './types';

export const channelsUr: ChannelsTranslation = {
  nav: 'چینلز',
  title: 'چینلز',
  description:
    'ای میل، واٹس ایپ اور ٹیلی گرام کا جواب اسی ان باکس سے دیں جس میں آپ کی ویب چیٹ آتی ہے۔',
  loading: 'چینلز لوڈ ہو رہے ہیں',
  guide: 'چینلز کیسے کام کرتے ہیں',
  brand: 'برانڈ',
  list: '{{brand}} کے چینلز',
  forbidden: {
    title: 'آپ چینلز کا انتظام نہیں کر سکتے',
    description:
      'ورک اسپیس کے مالک یا ایڈمن سے ایسا کردار مانگیں جس میں انٹیگریشنز سنبھالنے کی اجازت ہو۔',
  },
  noBrands: {
    title: 'ابھی کوئی برانڈ نہیں',
    description: 'پہلے ایک برانڈ شامل کریں۔ پھر اس کے چینلز یہاں جوڑیں۔',
    action: 'برانڈز اور انسٹال پر جائیں',
  },
  kind: {
    web: 'ویب چیٹ',
    email: 'ای میل',
    whatsapp: 'واٹس ایپ',
    telegram: 'ٹیلی گرام',
    other: 'دیگر',
  },
  status: {
    connected: 'جڑا ہوا',
    needs_attention: 'توجہ درکار ہے',
    paused: 'رکا ہوا',
  },
  problem: 'Chatwoot کا پیغام: {{problem}}',
  web: {
    text: 'آپ کی ویب سائٹ کا چیٹ ویجٹ۔',
    link: 'چیٹ ویجٹ کی ترتیبات',
  },
  conversations_one: 'اس ہفتے {{count}} گفتگو',
  conversations_other: 'اس ہفتے {{count}} گفتگوئیں',
  lastMessage: 'آخری پیغام: {{time}}',
  noMessages: 'ابھی کوئی پیغام نہیں',
  ai: {
    label: 'یہاں AI جواب دے',
    hint: 'بند: ہر گفتگو کا جواب آپ کی ٹیم دیتی ہے۔ چالو: پہلے AI جواب دیتا ہے اور ضرورت ہو تو گفتگو آپ کی ٹیم کو سونپ دیتا ہے۔',
    on: 'اب {{name}} پر پہلے AI جواب دیتا ہے۔',
    off: 'اب {{name}} پر ہر گفتگو کا جواب آپ کی ٹیم دیتی ہے۔',
  },
  team: {
    label: 'ٹیم',
    none: 'کوئی ٹیم نہیں (روٹنگ طے کرے)',
    hidden: 'ایسی ٹیم جو آپ کو نظر نہیں آتی',
    saved: '{{name}} پر نئی گفتگوئیں اب {{team}} کو جاتی ہیں۔',
    cleared: '{{name}} پر نئی گفتگوئیں کسے ملیں، یہ اب روٹنگ طے کرتی ہے۔',
  },
  pause: {
    action: 'روکیں',
    label: '{{name}} کو روکیں',
    title: 'کیا {{name}} کو روکنا ہے؟',
    body: 'جب تک آپ دوبارہ شروع نہ کریں، اس چینل کی نئی گفتگوئیں Chatwoot ہی میں رہیں گی۔ جو گفتگوئیں یہاں آ چکی ہیں وہ جاری رہیں گی۔',
    confirm: 'چینل روکیں',
    done: '{{name}} روک دیا گیا۔',
  },
  resume: {
    action: 'دوبارہ شروع کریں',
    label: '{{name}} دوبارہ شروع کریں',
    done: '{{name}} پھر سے چل رہا ہے۔',
  },
  unclaimed: {
    text: 'آپ کے Chatwoot اکاؤنٹ میں ملا۔',
    action: 'اس برانڈ کے لیے استعمال کریں',
    done: '{{name}} اب {{brand}} کی طرف سے جواب دیتا ہے۔',
  },
  empty: {
    title: 'ابھی کوئی ای میل، واٹس ایپ یا ٹیلی گرام چینل نہیں۔',
    description:
      'Chatwoot میں ایک چینل شامل کریں (Settings ← Inboxes)، پھر یہاں دوبارہ دیکھیں۔ Studio سے انہیں جوڑنے کی سہولت جلد آ رہی ہے۔',
  },
  check: {
    action: 'نئے چینلز تلاش کریں',
    busy: 'تلاش جاری ہے…',
    found_one: '{{count}} نیا چینل ملا',
    found_other: '{{count}} نئے چینلز ملے',
    none: 'کوئی نیا چینل نہیں ملا',
  },
  chatwoot: {
    title: 'Chatwoot نے جواب نہیں دیا',
    description: 'تھوڑی دیر بعد دوبارہ کوشش کریں۔',
  },
};
