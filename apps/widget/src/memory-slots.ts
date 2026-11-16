import { useTranslation } from 'react-i18next';

/** What a customer memory can be about; each has a name in the chat's languages. */
const SLOTS = new Set([
  'preferred_language',
  'preferred_name',
  'contact_method',
  'contact_time',
  'communication_style',
  'delivery_note',
  'product_interest',
  'size_preference',
  'open_issue',
  'stated_order_reference',
]);

/** The name of a memory slot in the chat's language; a slot the chat does not know keeps its key. */
export function useSlotLabel() {
  const { t } = useTranslation();
  return (key: string) => (SLOTS.has(key) ? t(`memory.slots.${key}`) : key);
}
