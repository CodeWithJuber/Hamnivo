import type { ChannelsTranslation } from './types';

export const channelsAr: ChannelsTranslation = {
  nav: 'القنوات',
  title: 'القنوات',
  description:
    'ردّ على البريد الإلكتروني وواتساب وتيليجرام من صندوق الوارد نفسه الذي تستخدمه للدردشة على موقعك.',
  loading: 'جارٍ تحميل القنوات',
  guide: 'كيف تعمل القنوات',
  brand: 'العلامة التجارية',
  list: 'قنوات {{brand}}',
  forbidden: {
    title: 'لا يمكنك إدارة القنوات',
    description: 'اطلب من مالك مساحة العمل أو مديرها دورًا يسمح بإدارة عمليات الربط.',
  },
  noBrands: {
    title: 'لا توجد علامة تجارية بعد',
    description: 'أضف علامة تجارية أولًا، ثم اربط قنواتها من هنا.',
    action: 'انتقل إلى العلامات التجارية والتثبيت',
  },
  kind: {
    web: 'الدردشة على الموقع',
    email: 'البريد الإلكتروني',
    whatsapp: 'واتساب',
    telegram: 'تيليجرام',
    other: 'قناة أخرى',
  },
  status: {
    connected: 'متصلة',
    needs_attention: 'تحتاج إلى انتباه',
    paused: 'متوقفة مؤقتًا',
  },
  problem: 'رسالة Chatwoot: {{problem}}',
  web: {
    text: 'أداة الدردشة على موقعك.',
    link: 'إعدادات أداة الدردشة',
  },
  // Arabic has six plural forms; the neutral “label: number” reads right for each.
  conversations_zero: 'محادثات هذا الأسبوع: {{count}}',
  conversations_one: 'محادثات هذا الأسبوع: {{count}}',
  conversations_two: 'محادثات هذا الأسبوع: {{count}}',
  conversations_few: 'محادثات هذا الأسبوع: {{count}}',
  conversations_many: 'محادثات هذا الأسبوع: {{count}}',
  conversations_other: 'محادثات هذا الأسبوع: {{count}}',
  lastMessage: 'آخر رسالة: {{time}}',
  noMessages: 'لا رسائل بعد',
  ai: {
    label: 'الذكاء الاصطناعي يردّ هنا',
    hint: 'عند الإيقاف: يردّ فريقك على كل محادثة. عند التشغيل: يردّ الذكاء الاصطناعي أولًا ويحوّل المحادثة إلى فريقك عند الحاجة.',
    on: 'أصبح الذكاء الاصطناعي يردّ أولًا على {{name}}.',
    off: 'أصبح فريقك يردّ على كل محادثة في {{name}}.',
  },
  team: {
    label: 'الفريق',
    none: 'بلا فريق (حسب التوجيه)',
    hidden: 'فريق لا يمكنك رؤيته',
    saved: 'المحادثات الجديدة في {{name}} تذهب الآن إلى {{team}}.',
    cleared: 'التوجيه هو الذي يحدّد الآن من يتلقى المحادثات الجديدة في {{name}}.',
  },
  pause: {
    action: 'إيقاف مؤقت',
    label: 'إيقاف {{name}} مؤقتًا',
    title: 'هل تريد إيقاف {{name}} مؤقتًا؟',
    body: 'تبقى المحادثات الجديدة على هذه القناة في Chatwoot حتى تستأنفها. أما المحادثات الموجودة هنا فتستمر كما هي.',
    confirm: 'إيقاف القناة مؤقتًا',
    done: 'أُوقفت {{name}} مؤقتًا.',
  },
  resume: {
    action: 'استئناف',
    label: 'استئناف {{name}}',
    done: 'عادت {{name}} إلى العمل.',
  },
  unclaimed: {
    text: 'وُجدت في حسابك على Chatwoot.',
    action: 'استخدمها لهذه العلامة التجارية',
    done: 'أصبحت {{name}} تردّ باسم {{brand}}.',
  },
  empty: {
    title: 'لا توجد قنوات بريد إلكتروني أو واتساب أو تيليجرام بعد.',
    description:
      'أضف قناة في Chatwoot (الإعدادات ← صناديق الوارد)، ثم تحقّق من هنا مرة أخرى. سيصبح ربطها من Studio متاحًا قريبًا.',
  },
  check: {
    action: 'البحث عن قنوات جديدة',
    busy: 'جارٍ البحث…',
    found_zero: 'قنوات جديدة وُجدت: {{count}}',
    found_one: 'قنوات جديدة وُجدت: {{count}}',
    found_two: 'قنوات جديدة وُجدت: {{count}}',
    found_few: 'قنوات جديدة وُجدت: {{count}}',
    found_many: 'قنوات جديدة وُجدت: {{count}}',
    found_other: 'قنوات جديدة وُجدت: {{count}}',
    none: 'لا توجد قنوات جديدة',
  },
  chatwoot: {
    title: 'لم يستجب Chatwoot',
    description: 'حاول مرة أخرى بعد قليل.',
  },
};
