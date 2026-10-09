import type { TicketsTranslation } from './types';

export const ticketsAr: TicketsTranslation = {
  guide: 'كيف تعمل التذاكر',
  states: {
    label: 'حالة التذكرة',
    open: 'مفتوحة',
    pending: 'معلّقة',
    closed: 'مغلقة',
    all: 'الكل',
  },
  stateBadge: {
    open: 'مفتوحة',
    pending: 'بانتظار العميل',
    closed: 'مغلقة',
  },
  stateHint: {
    open: 'يعمل فريقك عليها.',
    pending: 'بانتظار العميل. تُفتح مجددًا عندما يكتب.',
    closed: 'انتهت. تُفتح مجددًا إذا كتب العميل.',
  },
  priority: {
    label: 'الأولوية',
    any: 'أي أولوية',
    none: 'بلا أولوية',
    urgent: 'عاجلة',
    high: 'عالية',
    medium: 'متوسطة',
    low: 'منخفضة',
  },
  priorityBadge: {
    urgent: 'عاجلة',
    high: 'أولوية عالية',
    medium: 'أولوية متوسطة',
    low: 'أولوية منخفضة',
  },
  reference: 'التذكرة {{reference}}',
  source: {
    offline_form: 'تُركت عبر نموذج التواصل',
    staff: 'حوّلها فريقك إلى تذكرة',
    automation: 'حوّلتها أتمتة إلى تذكرة',
  },
  stateChanged: 'حالة التذكرة {{reference}} الآن: {{state}}.',
  priorityChanged: 'ضُبطت الأولوية على {{priority}}.',
  priorityCleared: 'أُزيلت الأولوية.',
  noPermission: 'لا يسمح دورك بتغيير حالة المحادثات أو أولويتها.',
  more: 'إجراءات أخرى',
  make: {
    item: 'حوّلها إلى تذكرة',
    title: 'تحويل هذه المحادثة إلى تذكرة',
    description: 'تحصل على رقم مرجعي وحالة وأولوية. ويبقى سجلها في هذه المحادثة.',
    priority: 'الأولوية',
    submit: 'أنشئ التذكرة',
    done: 'أُنشئت التذكرة {{reference}}.',
  },
  emptyFiltered: {
    title: 'لا توجد تذاكر مطابقة',
    description: 'جرّب حالة أو أولوية أخرى، أو اعرض كل التذاكر.',
    action: 'اعرض كل التذاكر',
  },
};
