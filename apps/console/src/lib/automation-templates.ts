/**
 * The rules a brand can start from (G21). Choosing one creates a draft with its definition, named
 * in the interface language, and opens the editor; nothing runs until it is published.
 *
 * The words customers read are written here in every language of the chat. Each definition
 * passes the contract, and none has a problem the domain would refuse to publish, except a value
 * the brand must choose itself (the tag of "Tag by page"): `test/automations.test.ts` checks both.
 */
import type * as C from '@hamnivo/contracts';
import type { AutomationKind } from '@hamnivo/domain/automations';

export const TEMPLATE_IDS = [
  'welcome',
  'rescue',
  'returning',
  'pricing',
  'outOfHours',
  'tagByPage',
  'scratchWebsite',
  'scratchChat',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface AutomationTemplate {
  id: TemplateId;
  kind: AutomationKind;
  definition: C.AutomationDefinition;
  /** Starting from nothing: shown apart from the ready-made rules. */
  scratch?: boolean;
  /** A value in the definition the brand still has to choose (shown in the gallery). */
  choose?: 'tag';
}

const NOT_AI = { field: 'owner', op: 'is_not', value: ['ai'] } as const;

export const TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'welcome',
    kind: 'conversation',
    definition: {
      event: { type: 'chat_started', seconds: 0 },
      match: 'all',
      conditions: [{ field: 'owner', op: 'is', value: ['waiting'] }],
      actions: [
        {
          type: 'send_message',
          message: {
            en: 'Thanks for your message. Someone from our team will reply shortly.',
            ar: 'شكرًا لرسالتك. سيرد عليك أحد أعضاء فريقنا قريبًا.',
            hi: 'आपके संदेश के लिए धन्यवाद। हमारी टीम का कोई सदस्य जल्द ही जवाब देगा।',
            ur: 'آپ کے پیغام کا شکریہ۔ ہماری ٹیم کا کوئی رکن جلد ہی جواب دے گا۔',
          },
        },
      ],
    },
  },
  {
    id: 'rescue',
    kind: 'conversation',
    definition: {
      event: { type: 'customer_waiting', seconds: 90 },
      match: 'all',
      conditions: [{ ...NOT_AI, value: [...NOT_AI.value] }],
      actions: [
        {
          type: 'send_message',
          message: {
            en: 'Sorry for the wait. We haven’t forgotten you. If you’d rather not wait, leave your email address and we’ll write to you.',
            ar: 'نعتذر عن الانتظار، لم ننسك. إن كنت تفضّل عدم الانتظار، فاترك بريدك الإلكتروني وسنكتب إليك.',
            hi: 'इंतज़ार के लिए माफ़ी। हम आपको भूले नहीं हैं। अगर आप इंतज़ार नहीं करना चाहते, तो अपना ईमेल पता छोड़ दें, हम आपको लिखेंगे।',
            ur: 'انتظار کے لیے معذرت۔ ہم آپ کو بھولے نہیں ہیں۔ اگر آپ انتظار نہیں کرنا چاہتے تو اپنا ای میل پتہ چھوڑ دیں، ہم آپ کو لکھیں گے۔',
          },
        },
        { type: 'set_priority', priority: 'high' },
      ],
    },
  },
  {
    id: 'returning',
    kind: 'visitor',
    definition: {
      event: { type: 'page_view', seconds: 5 },
      match: 'all',
      conditions: [{ field: 'visit_count', op: 'at_least', value: 3 }],
      actions: [
        {
          type: 'show_prompt',
          message: {
            en: 'Welcome back! Can we help you find something?',
            ar: 'أهلًا بعودتك! هل يمكننا مساعدتك في العثور على شيء؟',
            hi: 'फिर से स्वागत है! क्या हम कुछ ढूँढने में आपकी मदद करें?',
            ur: 'دوبارہ خوش آمدید! کیا ہم کچھ ڈھونڈنے میں آپ کی مدد کریں؟',
          },
        },
      ],
    },
  },
  {
    id: 'pricing',
    kind: 'visitor',
    definition: {
      event: { type: 'page_view', seconds: 30 },
      match: 'all',
      conditions: [{ field: 'page_url', op: 'contains', value: '/pricing' }],
      actions: [
        {
          type: 'show_prompt',
          message: {
            en: 'Questions about our plans? Ask us here.',
            ar: 'لديك أسئلة عن خططنا؟ اسألنا هنا.',
            hi: 'हमारे प्लान के बारे में सवाल हैं? यहाँ पूछें।',
            ur: 'ہمارے پلانز کے بارے میں سوالات ہیں؟ یہاں پوچھیں۔',
          },
        },
      ],
    },
  },
  {
    id: 'outOfHours',
    kind: 'conversation',
    definition: {
      event: { type: 'chat_started', seconds: 0 },
      match: 'all',
      conditions: [
        { field: 'hours_open', op: 'is', value: false },
        { ...NOT_AI, value: [...NOT_AI.value] },
      ],
      actions: [
        {
          type: 'send_message',
          message: {
            en: 'Thanks for your message. We’re closed right now, so we’ve made it a ticket and will reply when we’re back.',
            ar: 'شكرًا لرسالتك. نحن مغلقون الآن، لذا حوّلناها إلى تذكرة وسنرد عند عودتنا.',
            hi: 'आपके संदेश के लिए धन्यवाद। अभी हम बंद हैं, इसलिए हमने इसे टिकट बना दिया है और लौटने पर जवाब देंगे।',
            ur: 'آپ کے پیغام کا شکریہ۔ ہم ابھی بند ہیں، اس لیے ہم نے اسے ٹکٹ بنا دیا ہے اور واپسی پر جواب دیں گے۔',
          },
        },
        { type: 'make_ticket' },
      ],
    },
  },
  {
    id: 'tagByPage',
    kind: 'conversation',
    choose: 'tag',
    definition: {
      event: { type: 'chat_started', seconds: 0 },
      match: 'all',
      conditions: [{ field: 'page_url', op: 'contains', value: '/checkout' }],
      // A tag the brand replaces with one of its own before publishing.
      actions: [{ type: 'add_tag', tag: 'checkout' }],
    },
  },
  {
    id: 'scratchWebsite',
    kind: 'visitor',
    scratch: true,
    definition: {
      event: { type: 'page_view', seconds: 10 },
      match: 'all',
      conditions: [],
      actions: [
        {
          type: 'show_prompt',
          message: {
            en: 'Questions? We’re here to help.',
            ar: 'لديك أسئلة؟ نحن هنا لمساعدتك.',
            hi: 'कोई सवाल? हम मदद के लिए यहाँ हैं।',
            ur: 'کوئی سوال؟ ہم مدد کے لیے یہاں ہیں۔',
          },
        },
      ],
    },
  },
  {
    id: 'scratchChat',
    kind: 'conversation',
    scratch: true,
    definition: {
      event: { type: 'chat_started', seconds: 0 },
      match: 'all',
      conditions: [],
      actions: [{ type: 'set_priority', priority: 'medium' }],
    },
  },
];

export const templateOf = (id: TemplateId): AutomationTemplate =>
  TEMPLATES.find((template) => template.id === id) as AutomationTemplate;

/** A copy of a definition, so a draft never shares lists with a template. */
export const copyOf = (definition: C.AutomationDefinition): C.AutomationDefinition =>
  JSON.parse(JSON.stringify(definition)) as C.AutomationDefinition;
