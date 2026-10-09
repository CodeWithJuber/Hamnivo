import type { TicketsTranslation } from './types';

export const ticketsHi: TicketsTranslation = {
  guide: 'टिकट कैसे काम करते हैं',
  states: {
    label: 'टिकट की स्थिति',
    open: 'खुला',
    pending: 'रुका हुआ',
    closed: 'बंद',
    all: 'सभी',
  },
  stateBadge: {
    open: 'खुला',
    pending: 'ग्राहक के जवाब का इंतज़ार',
    closed: 'बंद',
  },
  stateHint: {
    open: 'आपकी टीम इस पर काम कर रही है।',
    pending: 'ग्राहक के जवाब का इंतज़ार है। उनके लिखते ही यह फिर खुल जाता है।',
    closed: 'पूरा हो गया। ग्राहक के लिखने पर यह फिर खुल जाता है।',
  },
  priority: {
    label: 'प्राथमिकता',
    any: 'कोई भी प्राथमिकता',
    none: 'कोई प्राथमिकता नहीं',
    urgent: 'तत्काल',
    high: 'ऊँची',
    medium: 'मध्यम',
    low: 'नीची',
  },
  priorityBadge: {
    urgent: 'तत्काल',
    high: 'ऊँची प्राथमिकता',
    medium: 'मध्यम प्राथमिकता',
    low: 'नीची प्राथमिकता',
  },
  reference: 'टिकट {{reference}}',
  source: {
    offline_form: 'संपर्क फ़ॉर्म से छोड़ा गया',
    staff: 'आपकी टीम ने टिकट बनाया',
    automation: 'एक ऑटोमेशन ने टिकट बनाया',
    email: 'ईमेल से आया',
  },
  stateChanged: 'टिकट {{reference}} अब: {{state}}।',
  priorityChanged: 'प्राथमिकता {{priority}} कर दी गई।',
  priorityCleared: 'प्राथमिकता हटा दी गई।',
  noPermission: 'आपकी भूमिका बातचीत की स्थिति या प्राथमिकता नहीं बदल सकती।',
  more: 'और कार्रवाइयाँ',
  make: {
    item: 'इसे टिकट बनाएँ',
    title: 'इस बातचीत को टिकट बनाएँ',
    description: 'इसे एक संदर्भ नंबर, स्थिति और प्राथमिकता मिलती है। इतिहास इसी बातचीत में रहता है।',
    priority: 'प्राथमिकता',
    submit: 'टिकट बनाएँ',
    done: 'टिकट {{reference}} बन गया।',
  },
  emptyFiltered: {
    title: 'कोई मेल खाता टिकट नहीं',
    description: 'कोई दूसरी स्थिति या प्राथमिकता आज़माएँ, या सभी टिकट देखें।',
    action: 'सभी टिकट देखें',
  },
};
