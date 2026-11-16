/**
 * Draft replies streamed before they are published (`message.delta`). A draft is provisional: it
 * is shown as an answer still being checked, never as a message. It becomes final only as the
 * `message.created` that publishes the reply, and `message.draft_discarded` withdraws it (for
 * example when the answer check finds a sentence its source does not support), so nothing from
 * a withdrawn draft stays on screen.
 */
export interface Draft {
  draftId: string;
  runId: string;
  /** Streamed pieces by their index, so a repeated or late piece cannot garble the text. */
  pieces: readonly string[];
}

export interface DraftEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** The events that change drafts. */
export const DRAFT_EVENTS: ReadonlySet<string> = new Set([
  'message.delta',
  'message.draft_discarded',
  'message.created',
  'conversation.updated',
]);

export const draftText = (draft: Draft) => draft.pieces.join('');

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** Applies one live event to the drafts on screen; unrelated events change nothing. */
export function applyDraftEvent(drafts: readonly Draft[], event: DraftEvent): readonly Draft[] {
  const data = event.data ?? {};
  switch (event.type) {
    case 'message.delta': {
      const draftId = text(data.draftId);
      const runId = text(data.runId);
      const delta = text(data.textDelta);
      const index = data.index;
      if (!draftId || !runId || delta === null || typeof index !== 'number' || index < 0) {
        return drafts;
      }
      const current = drafts.find((d) => d.draftId === draftId);
      const pieces = [...(current?.pieces ?? [])];
      if (pieces[index] !== undefined) return drafts;
      pieces[index] = delta;
      const next: Draft = { draftId, runId, pieces: Array.from(pieces, (p) => p ?? '') };
      return current ? drafts.map((d) => (d === current ? next : d)) : [...drafts, next];
    }
    case 'message.draft_discarded': {
      const draftId = text(data.draftId);
      return draftId ? drafts.filter((d) => d.draftId !== draftId) : drafts;
    }
    case 'message.created': {
      // A published AI reply replaces its draft: the one it names, or every draft when it
      // names none (a gateway from before drafts were named).
      const message = data.message as { sender?: { kind?: string } } | undefined;
      if (message?.sender?.kind !== 'ai_agent' || drafts.length === 0) return drafts;
      const draftId = text(data.draftId);
      if (!draftId) return [];
      const left = drafts.filter((d) => d.draftId !== draftId);
      return left.length === drafts.length ? drafts : left;
    }
    case 'conversation.updated':
      // A person took over or the AI stepped back: no AI draft can still become a reply.
      return data.responder !== 'ai' && drafts.length > 0 ? [] : drafts;
    default:
      return drafts;
  }
}
