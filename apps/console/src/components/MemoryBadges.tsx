import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import type { TFunction } from 'i18next';
import {
  ClipboardListIcon,
  ClockIcon,
  GlobeIcon,
  MailIcon,
  PackageIcon,
  RulerIcon,
  ShoppingBagIcon,
  SmileIcon,
  TagIcon,
  TruckIcon,
  UserRoundIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryCustomerSummary, MemoryDeletionReceipt, MemoryItem } from '../lib/types';

/** Slots Hamnivo remembers, as in the write policy's catalogue (@hamnivo/domain). */
export const MEMORY_SLOTS = [
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
] as const;
export type MemorySlotKey = (typeof MEMORY_SLOTS)[number];

const isSlot = (key: string): key is MemorySlotKey =>
  (MEMORY_SLOTS as readonly string[]).includes(key);

const SLOT_ICONS: Record<MemorySlotKey, ComponentType<{ className?: string }>> = {
  preferred_language: GlobeIcon,
  preferred_name: UserRoundIcon,
  contact_method: MailIcon,
  contact_time: ClockIcon,
  communication_style: SmileIcon,
  delivery_note: TruckIcon,
  product_interest: ShoppingBagIcon,
  size_preference: RulerIcon,
  open_issue: ClipboardListIcon,
  stated_order_reference: PackageIcon,
};

export function SlotIcon({ slot, className }: { slot: string; className?: string }) {
  const Icon = isSlot(slot) ? SLOT_ICONS[slot] : TagIcon;
  return <Icon className={className ?? 'size-5 shrink-0 text-text-muted'} aria-hidden="true" />;
}

export function slotLabel(t: TFunction, key: string): string {
  return isSlot(key) ? t(`memory.slots.${key}.label`) : key;
}

export function slotPurpose(t: TFunction, item: Pick<MemoryItem, 'key' | 'purpose'>): string {
  return isSlot(item.key) ? t(`memory.slots.${item.key}.purpose`) : item.purpose;
}

/** Preferences, and facts the customer mentioned in a conversation. */
export const isPreference = (item: Pick<MemoryItem, 'kind'>) => item.kind === 'preference';

export function customerName(
  t: TFunction,
  customer: { displayName: string | null; verified: boolean },
): string {
  return (
    customer.displayName ??
    t(customer.verified ? 'memory.customer.unnamed' : 'memory.customer.anonymous')
  );
}

export function ConsentBadge({ state }: { state: MemoryCustomerSummary['consent'] }) {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={state === 'granted' ? 'success' : 'neutral'} data-consent={state}>
      {t(`memory.consent.${state}`)}
    </StatusBadge>
  );
}

export function MemoryStatusBadge({ item }: { item: Pick<MemoryItem, 'status'> }) {
  const { t } = useTranslation();
  const tone =
    item.status === 'active' ? 'success' : item.status === 'pending' ? 'warning' : 'neutral';
  return (
    <StatusBadge tone={tone} data-memory-status={item.status}>
      {t(`memory.status.${item.status}`)}
    </StatusBadge>
  );
}

export function DeletionStatusBadge({ receipt }: { receipt: MemoryDeletionReceipt }) {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={receipt.status === 'completed' ? 'success' : 'info'}>
      {t(`memory.deletions.status.${receipt.status}`)}
    </StatusBadge>
  );
}

/** Where a memory came from, in words: "Customer message", "Set by the customer", … */
export function sourceLabel(t: TFunction, item: Pick<MemoryItem, 'source'>): string {
  return t(`memory.sources.${item.source.type}`);
}
