import type { PaletteTranslation } from './en';

/** Arabic (Modern Standard). Pending review by native speakers, as the note in the interface says. */
export const paletteAr: PaletteTranslation = {
  open: 'ابحث في الصفحات',
  button: 'ابحث',
  title: 'انتقل إلى صفحة',
  description: 'اكتب للعثور على صفحة يمكنك فتحها. استخدم مفاتيح الأسهم للاختيار، ثم Enter لفتحها.',
  placeholder: 'اكتب اسم صفحة، مثل المعرفة أو الفريق والصلاحيات',
  empty: 'لا توجد صفحة تطابق «{{query}}».',
  emptyHint: 'جرّب كلمة أخرى. تظهر فقط الصفحات التي يمكنك فتحها.',
  current: 'أنت هنا',
  account: 'حسابك',
  hint: {
    move: 'للتنقل',
    open: 'للفتح',
    close: 'للإغلاق',
  },
};
