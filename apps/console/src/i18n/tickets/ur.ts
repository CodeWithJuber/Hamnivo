import type { TicketsTranslation } from './types';

export const ticketsUr: TicketsTranslation = {
  guide: 'ٹکٹ کیسے کام کرتے ہیں',
  states: {
    label: 'ٹکٹ کی حالت',
    open: 'کھلا',
    pending: 'رکا ہوا',
    closed: 'بند',
    all: 'سب',
  },
  stateBadge: {
    open: 'کھلا',
    pending: 'گاہک کے جواب کا انتظار',
    closed: 'بند',
  },
  stateHint: {
    open: 'آپ کی ٹیم اس پر کام کر رہی ہے۔',
    pending: 'گاہک کے جواب کا انتظار ہے۔ ان کے لکھتے ہی یہ پھر کھل جاتا ہے۔',
    closed: 'مکمل ہو گیا۔ گاہک کے لکھنے پر یہ پھر کھل جاتا ہے۔',
  },
  priority: {
    label: 'ترجیح',
    any: 'کوئی بھی ترجیح',
    none: 'کوئی ترجیح نہیں',
    urgent: 'فوری',
    high: 'زیادہ',
    medium: 'درمیانی',
    low: 'کم',
  },
  priorityBadge: {
    urgent: 'فوری',
    high: 'زیادہ ترجیح',
    medium: 'درمیانی ترجیح',
    low: 'کم ترجیح',
  },
  reference: 'ٹکٹ {{reference}}',
  source: {
    offline_form: 'رابطہ فارم سے چھوڑا گیا',
    staff: 'آپ کی ٹیم نے ٹکٹ بنایا',
    automation: 'ایک آٹومیشن نے ٹکٹ بنایا',
    email: 'ای میل سے آیا',
  },
  stateChanged: 'ٹکٹ {{reference}} اب: {{state}}۔',
  priorityChanged: 'ترجیح {{priority}} کر دی گئی۔',
  priorityCleared: 'ترجیح ہٹا دی گئی۔',
  noPermission: 'آپ کا کردار گفتگو کی حالت یا ترجیح نہیں بدل سکتا۔',
  more: 'مزید اقدامات',
  make: {
    item: 'اسے ٹکٹ بنائیں',
    title: 'اس گفتگو کو ٹکٹ بنائیں',
    description: 'اسے ایک حوالہ نمبر، حالت اور ترجیح ملتی ہے۔ تاریخ اسی گفتگو میں رہتی ہے۔',
    priority: 'ترجیح',
    submit: 'ٹکٹ بنائیں',
    done: 'ٹکٹ {{reference}} بن گیا۔',
  },
  emptyFiltered: {
    title: 'کوئی ملتا جلتا ٹکٹ نہیں',
    description: 'کوئی دوسری حالت یا ترجیح آزمائیں، یا تمام ٹکٹ دیکھیں۔',
    action: 'تمام ٹکٹ دیکھیں',
  },
};
