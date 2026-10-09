import type { ChannelsTranslation } from './types';

export const channelsHi: ChannelsTranslation = {
  nav: 'चैनल',
  title: 'चैनल',
  description: 'ईमेल, WhatsApp और Telegram का जवाब उसी इनबॉक्स से दें जिसमें आपकी वेब चैट आती है।',
  loading: 'चैनल लोड हो रहे हैं',
  guide: 'चैनल कैसे काम करते हैं',
  brand: 'ब्रांड',
  list: '{{brand}} के चैनल',
  forbidden: {
    title: 'आप चैनल नहीं सँभाल सकते',
    description: 'वर्कस्पेस के मालिक या एडमिन से ऐसी भूमिका माँगें जिसमें इंटीग्रेशन सँभालने की अनुमति हो।',
  },
  noBrands: {
    title: 'अभी कोई ब्रांड नहीं है',
    description: 'पहले एक ब्रांड जोड़ें। फिर उसके चैनल यहाँ जोड़ें।',
    action: 'ब्रांड और इंस्टॉल पर जाएँ',
  },
  kind: {
    web: 'वेब चैट',
    email: 'ईमेल',
    whatsapp: 'व्हाट्सऐप',
    telegram: 'टेलीग्राम',
    other: 'अन्य',
  },
  status: {
    connected: 'जुड़ा हुआ',
    needs_attention: 'ध्यान चाहिए',
    paused: 'रुका हुआ',
  },
  problem: 'Chatwoot का संदेश: {{problem}}',
  web: {
    text: 'आपकी वेबसाइट का चैट विजेट।',
    link: 'चैट विजेट की सेटिंग',
  },
  conversations_one: 'इस हफ़्ते {{count}} बातचीत',
  conversations_other: 'इस हफ़्ते {{count}} बातचीतें',
  lastMessage: 'आख़िरी संदेश: {{time}}',
  noMessages: 'अभी कोई संदेश नहीं',
  ai: {
    label: 'यहाँ AI जवाब दे',
    hint: 'बंद: हर बातचीत का जवाब आपकी टीम देती है। चालू: पहले AI जवाब देता है और ज़रूरत पड़ने पर बातचीत आपकी टीम को सौंप देता है।',
    on: 'अब {{name}} पर पहले AI जवाब देता है।',
    off: 'अब {{name}} पर हर बातचीत का जवाब आपकी टीम देती है।',
  },
  team: {
    label: 'टीम',
    none: 'कोई टीम नहीं (रूटिंग तय करे)',
    hidden: 'ऐसी टीम जो आपको नहीं दिखती',
    saved: '{{name}} पर नई बातचीतें अब {{team}} को जाती हैं।',
    cleared: '{{name}} पर नई बातचीतें किसे मिलें, यह अब रूटिंग तय करती है।',
  },
  pause: {
    action: 'रोकें',
    label: '{{name}} को रोकें',
    title: '{{name}} को रोकें?',
    body: 'जब तक आप फिर से शुरू नहीं करते, इस चैनल की नई बातचीतें Chatwoot में ही रहेंगी। जो बातचीतें यहाँ आ चुकी हैं, वे चलती रहेंगी।',
    confirm: 'चैनल रोकें',
    done: '{{name}} रोक दिया गया।',
  },
  resume: {
    action: 'फिर शुरू करें',
    label: '{{name}} फिर शुरू करें',
    done: '{{name}} फिर से चल रहा है।',
  },
  unclaimed: {
    text: 'आपके Chatwoot खाते में मिला।',
    action: 'इस ब्रांड के लिए इस्तेमाल करें',
    done: '{{name}} अब {{brand}} के लिए जवाब देता है।',
  },
  empty: {
    title: 'अभी कोई ईमेल, WhatsApp या Telegram चैनल नहीं है।',
    description:
      'Chatwoot में एक चैनल जोड़ें (Settings → Inboxes), फिर यहाँ दोबारा देखें। Studio से इन्हें जोड़ने की सुविधा जल्द आ रही है।',
  },
  check: {
    action: 'नए चैनल खोजें',
    busy: 'खोज रहे हैं…',
    found_one: '{{count}} नया चैनल मिला',
    found_other: '{{count}} नए चैनल मिले',
    none: 'कोई नया चैनल नहीं मिला',
  },
  chatwoot: {
    title: 'Chatwoot ने जवाब नहीं दिया',
    description: 'थोड़ी देर में फिर कोशिश करें।',
  },
};
