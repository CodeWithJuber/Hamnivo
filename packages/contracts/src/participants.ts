import { z } from 'zod';

/**
 * Who authored a message. AI and human identities are always distinct (blueprint W04, U09):
 * an AI participant is never presented with a person's name or photo, and never claims to have
 * manually checked something a human did not check.
 */
export const SenderKind = z.enum([
  'customer',
  'human_agent',
  'ai_agent',
  'ai_specialist',
  'guest',
  'external_agent',
  'system',
]);
export type SenderKind = z.infer<typeof SenderKind>;

export const AI_SENDER_KINDS: ReadonlySet<SenderKind> = new Set([
  'ai_agent',
  'ai_specialist',
  'external_agent',
]);

export const Sender = z
  .object({
    kind: SenderKind,
    /** Stable participant reference (prt_…); omitted for system notices. */
    id: z.string().optional(),
    displayName: z.string().max(120),
    /** Role shown next to the name, e.g. "AI assistant", "Billing specialist", "Support agent". */
    roleLabel: z.string().max(80).optional(),
    avatarUrl: z.url().optional(),
  })
  .meta({ id: 'Sender' });
export type Sender = z.infer<typeof Sender>;

export const ParticipantMode = z.enum(['public', 'assist', 'background']);

export const Participant = z
  .object({
    id: z.string(),
    kind: SenderKind,
    displayName: z.string().max(120),
    roleLabel: z.string().max(80).optional(),
    mode: ParticipantMode,
    joinedAt: z.iso.datetime({ offset: true }),
    leftAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'Participant' });
export type Participant = z.infer<typeof Participant>;
