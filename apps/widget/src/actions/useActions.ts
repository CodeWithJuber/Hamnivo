import {
  ActionsApi,
  type CustomerAction,
  HamnivoApiError,
  type HamnivoClient,
} from '@hamnivo/client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { HostBridge } from '../bridge.js';

/** Why the last decision on a request did not go through (translated by the card). */
export type ActionProblem = 'identity' | 'mismatch' | 'expired' | 'gone' | 'error';

function problemOf(error: unknown): ActionProblem {
  if (!(error instanceof HamnivoApiError)) return 'error';
  switch (error.code) {
    case 'IDENTITY_REQUIRED':
      return 'identity';
    case 'APPROVAL_MISMATCH':
      return 'mismatch';
    case 'APPROVAL_EXPIRED':
      return 'expired';
    case 'VERSION_CONFLICT':
    case 'NOT_FOUND':
      return 'gone';
    default:
      return 'error';
  }
}

export interface ActionsController {
  /** The live request behind an approval card, once loaded. */
  action: (actionId: string) => CustomerAction | undefined;
  /** Loads a request shown in the conversation (once, unless forced). */
  ensure: (actionId: string, force?: boolean) => Promise<void>;
  decide: (
    actionId: string,
    argumentsHash: string,
    decision: 'approve' | 'decline',
  ) => Promise<boolean>;
  busy: string | null;
  problems: Record<string, ActionProblem>;
  /** Live events of the conversation (approval.updated, action.updated). */
  onEvent: (event: { type: string; data?: Record<string, unknown> }) => void;
}

/**
 * The customer's AI action requests in one conversation (W16). Every card is checked against the
 * live request: buttons appear only while it waits for this customer and its arguments hash is
 * the one on the card. A repeated tap sends the same request id; a request that asks who the
 * customer is tells the host page (`identity.required`) so it can sign them in.
 */
export function useActions(
  client: HamnivoClient,
  conversationId: string | null,
  bridge: HostBridge,
): ActionsController {
  const api = useMemo(() => new ActionsApi(client), [client]);
  const [actions, setActions] = useState<Record<string, CustomerAction>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, ActionProblem>>({});
  const loading = useRef(new Set<string>());
  const requestIds = useRef(new Map<string, string>());

  useEffect(() => {
    setActions({});
    setProblems({});
    loading.current.clear();
    if (conversationId === null) requestIds.current.clear();
  }, [conversationId]);

  const ensure = useCallback(
    async (actionId: string, force = false) => {
      if (!conversationId || (!force && loading.current.has(actionId))) return;
      loading.current.add(actionId);
      try {
        const found = await api.getAction(conversationId, actionId);
        setActions((all) => ({ ...all, [actionId]: found }));
      } catch {
        loading.current.delete(actionId);
      }
    },
    [api, conversationId],
  );

  const decide = useCallback(
    async (actionId: string, argumentsHash: string, decision: 'approve' | 'decline') => {
      if (!conversationId) return false;
      const key = `${actionId}:${decision}`;
      let clientRequestId = requestIds.current.get(key);
      if (!clientRequestId) {
        clientRequestId = crypto.randomUUID();
        requestIds.current.set(key, clientRequestId);
      }
      setBusy(actionId);
      setProblems(({ [actionId]: _, ...rest }) => rest);
      try {
        const updated = await api.decide(conversationId, actionId, {
          decision,
          argumentsHash,
          clientRequestId,
        });
        setActions((all) => ({ ...all, [actionId]: updated }));
        return true;
      } catch (error) {
        const problem = problemOf(error);
        setProblems((all) => ({ ...all, [actionId]: problem }));
        if (problem === 'identity') {
          // A new identity is a new attempt: the next tap gets a new request id.
          requestIds.current.delete(key);
          bridge.post({ type: 'event', event: 'identity.required', payload: { actionId } });
        }
        await ensure(actionId, true);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, bridge, conversationId, ensure],
  );

  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const onEvent = useCallback(
    (event: { type: string; data?: Record<string, unknown> }) => {
      const data = event.data ?? {};
      const id =
        event.type === 'approval.updated'
          ? data.approvalId
          : event.type === 'action.updated'
            ? data.actionId
            : null;
      if (typeof id === 'string' && id.startsWith('act_') && actionsRef.current[id]) {
        void ensure(id, true);
      }
    },
    [ensure],
  );

  const action = useCallback((actionId: string) => actions[actionId], [actions]);
  return { action, ensure, decide, busy, problems, onEvent };
}

export const ActionsContext = createContext<ActionsController | null>(null);

export const useActionsController = () => useContext(ActionsContext);
