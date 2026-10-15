/**
 * AI drafts awaiting review (HNV-09-05) in Studio: the draft an assist-mode agent wrote for the
 * conversation, and the calls that approve (as written or edited) or reject it. Keyed under the
 * conversation, so the live stream's change of a conversation refreshes it with the rest.
 */
import type * as C from '@hamnivo/contracts';
import { api } from './api';
import { inboxKeys } from './inbox';
import { useStudioQuery } from './queries';

export type AiDraft = C.AiDraft;
export type AiDraftList = C.AiDraftList;
export type AiDraftRejectReason = C.AiDraftRejectReason;
export type AiDraftDecisionResult = C.AiDraftDecisionResult;

/** Why a reviewer rejects a draft, in the order the dialog offers them. */
export const REJECT_REASONS: readonly AiDraftRejectReason[] = [
  'inaccurate',
  'incomplete',
  'wrong_tone',
  'not_needed',
  'other',
];

const path = (id: string, rest = '') =>
  `/v1/inbox/conversations/${encodeURIComponent(id)}/ai-drafts${rest}`;

export const useAiDrafts = (conversationId: string, enabled = true) =>
  useStudioQuery<AiDraftList>(inboxKeys.part(conversationId, 'ai-drafts'), path(conversationId), {
    enabled,
  });

export const approveAiDraft = (
  tenantId: string,
  conversationId: string,
  draftId: string,
  body: { clientRequestId: string; expectedEpoch: number; text?: string },
) =>
  api<AiDraftDecisionResult>(path(conversationId, `/${encodeURIComponent(draftId)}/approve`), {
    method: 'POST',
    tenant: tenantId,
    body,
  });

export const rejectAiDraft = (
  tenantId: string,
  conversationId: string,
  draftId: string,
  body: { clientRequestId: string; reason: AiDraftRejectReason; note?: string },
) =>
  api<AiDraftDecisionResult>(path(conversationId, `/${encodeURIComponent(draftId)}/reject`), {
    method: 'POST',
    tenant: tenantId,
    body,
  });
