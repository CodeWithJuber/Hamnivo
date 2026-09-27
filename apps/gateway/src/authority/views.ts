import type { DeliveryState, MemoryPart, Message, Sender, SourcePart } from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import type { OwnerMode } from '@hamnivo/db/schema';
import type { AuthorityMessage } from '@hamnivo/domain';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { z } from 'zod';

export type SourceRef = z.infer<typeof SourcePart>;
export type MemoryPartRef = z.infer<typeof MemoryPart>;

/** What Hamnivo recorded about an AI answer it published. */
export interface PublicationFacts {
  sources: SourceRef[];
  /** The agent's display name at the time (a role such as "AI assistant"). */
  displayName?: string;
  /** Customer memories the answer relied on (G19); removed when a memory is deleted. */
  memories?: MemoryPartRef[];
}

/**
 * Facts about AI answers Hamnivo published in a conversation, by authority message id. They come
 * from Hamnivo's own records, so nothing written into the authority by others can pose as a
 * citation or an agent's name. (Chatwoot's customer view does not return message keys, so the
 * match is on the message id that was recorded when the answer was posted.)
 */
export async function publicationFacts(
  tx: TenantTx,
  conversationId: string,
  messages: Pick<AuthorityMessage, 'ref' | 'key'>[],
): Promise<Map<string, PublicationFacts>> {
  const refs = [...new Set(messages.map((m) => Number(m.ref)).filter(Number.isSafeInteger))];
  const keys = [...new Set(messages.map((m) => m.key).filter((k) => k?.startsWith('hv1:p:')))];
  if (refs.length === 0 && keys.length === 0) return new Map();
  const rows = await tx
    .select({
      key: schema.publications.sourceKey,
      authorityId: schema.publications.authorityMessageId,
      detail: schema.publications.detail,
    })
    .from(schema.publications)
    .where(
      and(
        eq(schema.publications.conversationId, conversationId),
        or(
          refs.length ? inArray(schema.publications.authorityMessageId, refs) : undefined,
          keys.length ? inArray(schema.publications.sourceKey, keys as string[]) : undefined,
        ),
      ),
    );
  const found = new Map<string, PublicationFacts>();
  for (const row of rows) {
    const detail = (row.detail ?? {}) as {
      sources?: SourceRef[];
      displayName?: string;
      memories?: MemoryPartRef[];
    };
    const facts: PublicationFacts = {
      sources: detail.sources ?? [],
      ...(detail.displayName ? { displayName: detail.displayName } : {}),
      ...(detail.memories?.length ? { memories: detail.memories } : {}),
    };
    const byKey = messages.find((m) => m.key === row.key);
    const ref = byKey?.ref ?? (row.authorityId === null ? null : String(row.authorityId));
    if (ref) found.set(ref, facts);
  }
  return found;
}

export type CustomerStatus = 'open' | 'waiting_for_person' | 'with_person' | 'resolved';
export type Responder = 'ai' | 'person' | 'none';

/** What the customer is told about a conversation: who answers, never staff-only details. */
export function customerView(
  mode: OwnerMode,
  authorityStatus: string,
): { status: CustomerStatus; responder: Responder } {
  if (authorityStatus === 'resolved') return { status: 'resolved', responder: 'none' };
  switch (mode) {
    case 'AI_ACTIVE':
      return { status: 'open', responder: 'ai' };
    case 'WAITING_HUMAN':
      return { status: 'waiting_for_person', responder: 'none' };
    case 'HUMAN_ACTIVE':
      return { status: 'with_person', responder: 'person' };
    case 'PAUSED':
      return { status: 'open', responder: 'none' };
  }
}

/** AI and people are always labelled as what they are (W04, U09). */
export function senderOf(message: AuthorityMessage): Sender {
  const sender = message.sender;
  switch (sender.kind) {
    case 'contact':
      return { kind: 'customer', displayName: sender.name?.trim() || 'Customer' };
    case 'bot':
      return {
        kind: 'ai_agent',
        displayName: sender.name?.trim() || 'AI assistant',
        roleLabel: 'AI assistant',
      };
    case 'user':
      return {
        kind: 'human_agent',
        displayName: sender.name?.trim() || 'Support agent',
        roleLabel: 'Support agent',
      };
    default:
      return { kind: 'system', displayName: 'System' };
  }
}

/** Authority message → the public Message contract (customer or staff lane). */
export function contractMessage(input: {
  message: AuthorityMessage;
  id: string;
  conversationId: string;
  sequence: number | null;
  clientMessageId: string | null;
  delivery: DeliveryState | null;
  /** What Hamnivo recorded when it published this AI answer (never taken from the authority). */
  facts?: PublicationFacts;
}): Message {
  const sender = senderOf(input.message);
  if (sender.kind === 'ai_agent' && input.facts?.displayName) {
    sender.displayName = input.facts.displayName;
  }
  const text = input.message.text?.trim();
  return {
    id: input.id,
    conversationId: input.conversationId,
    sequence: input.sequence,
    sender,
    visibility: input.message.private ? 'internal' : 'public',
    parts: [
      {
        type: 'text',
        text: text || (input.message.attachments.length > 0 ? '[attachment]' : '[empty message]'),
        format: 'plain',
      },
      ...(input.facts?.sources ?? []),
      ...(input.facts?.memories ?? []),
    ],
    createdAt: input.message.createdAt.toISOString(),
    clientMessageId: input.clientMessageId,
    delivery: input.delivery,
    language: null,
  };
}

/** Which journal lane carries an authority message, if any (activity stays out of both). */
export function laneOf(message: AuthorityMessage): 'customer' | 'staff' | null {
  if (message.direction === 'activity') return null;
  return message.private ? 'staff' : 'customer';
}
