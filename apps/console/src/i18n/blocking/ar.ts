import type { BlockingTranslation } from './types';

export const blockingAr: BlockingTranslation = {
  menuItem: 'حظر الزائر…',
  menuItemSender: 'حظر المُرسِل…',
  action: 'حظر',
  actionFor: 'حظر {{name}}',
  dialog: {
    title: 'حظر {{name}}',
    explanation:
      'سيرون أن المحادثة غير متاحة. مسح بيانات المتصفح يتجاوز الحظر؛ أما العملاء المسجّلون فيبقون محظورين على أي جهاز.',
    reason: 'السبب',
    reasonHint: 'لا يراه إلا فريقك، في صفحة المحظورين.',
    reasonMissing: 'اكتب سبب حظرهم.',
    duration: 'المدة',
    closeChat: 'أغلق هذه المحادثة أيضًا',
    submit: 'احظر الزائر',
    done: 'تم حظر {{name}}.',
    doneClosed: 'تم حظر {{name}} وإغلاق المحادثة.',
    /** A sender on email, WhatsApp or Telegram. */
    sender: {
      explanation:
        'ستظل رسائلهم تصل، لكن كل محادثة تُغلق تلقائيًا دون رد. ولن يُبلَّغوا بذلك. يشمل الحظر هذا العنوان على هذه القناة فقط.',
      closeChat: 'أغلق هذه المحادثة أيضًا',
      submit: 'احظر المُرسِل',
      doneClosed: 'تم حظر {{name}} وإغلاق المحادثة.',
    },
  },
  durations: {
    day: '24 ساعة',
    week: '7 أيام',
    month: '30 يومًا',
    always: 'حتى رفع الحظر',
  },
  durationHints: {
    until: 'حتى {{time}}',
    never: 'حتى يرفع أحد أعضاء فريقك الحظر',
  },
  page: {
    link: 'المحظورون',
    /** An anonymous visitor, by the short code that tells them apart. */
    anonymous: 'زائر {{code}}',
    /** After a sender's address, which comes first in every language: "amina@… on Email". */
    senderOn: 'على {{channel}}',
    /** A sender with no address (Telegram). */
    senderNoAddress: 'مُرسِل على {{channel}}',
    title: 'الزوار المحظورون',
    description:
      'الزوار الذين لا يمكنهم مراسلة علاماتك التجارية، وسبب حظرهم وحتى متى. ارفع الحظر هنا ليتمكنوا من المراسلة فورًا.',
    guide: 'كيف يعمل الحظر',
    back: 'العودة إلى صندوق الوارد',
    loading: 'جارٍ تحميل الزوار المحظورين',
    table: 'الزوار المحظورون، الأحدث أولًا',
    show: 'عرض',
    filters: {
      active: 'السارية',
      all: 'الكل (آخر 90 يومًا)',
    },
    brand: 'العلامة التجارية',
    allBrands: 'كل العلامات التجارية',
    columns: {
      who: 'مَن',
      reason: 'السبب',
      by: 'حظره',
      when: 'متى',
      expires: 'ينتهي',
      actions: 'الإجراءات',
    },
    signedIn: 'مسجّل الدخول',
    formerStaff: 'شخص لم يعد في الفريق',
    standing: {
      never: 'حتى رفع الحظر',
      lifted: 'رُفع الحظر {{time}}',
      liftedBy: 'رفع {{name}} الحظر، {{time}}',
      expired: 'انتهى {{time}}',
    },
    openChat: 'فتح المحادثة',
    openChatFor: 'فتح المحادثة مع {{name}}',
    unblock: 'رفع الحظر',
    unblockFor: 'رفع الحظر عن {{name}}',
    confirm: {
      title: 'رفع الحظر عن {{name}}؟',
      body: 'يمكنهم بدء المراسلة من جديد فورًا. يبقى الحظر مدرجًا هنا مع علامة رفعه.',
      submit: 'ارفع الحظر',
      done: 'تم رفع الحظر عن {{name}}.',
      failed: 'ما زال {{name}} محظورًا.',
    },
    empty: {
      title: 'لا أحد محظور',
      description:
        'عندما يسيء أحدهم استخدام المحادثة، احظره من قائمة «إجراءات أخرى» في المحادثة أو من صفحة «الزوار المباشرون».',
      allTitle: 'لا حظر في آخر 90 يومًا',
    },
    forbidden: {
      title: 'لا يمكنك رؤية الزوار المحظورين',
      description: 'دورك لا يسمح بحظر الزوار أو رفع الحظر عنهم. اطلب ذلك من مسؤول أو مشرف.',
    },
  },
};
