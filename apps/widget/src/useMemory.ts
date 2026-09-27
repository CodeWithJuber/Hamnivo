import type { HamnivoClient } from '@hamnivo/client';
import {
  type CustomerMemory,
  MEMORY_NOTICE_VERSION,
  type MemoryChange,
  type MemoryDeletionReceipt,
} from '@hamnivo/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface MemoryState {
  phase: 'loading' | 'ready' | 'error';
  memory: CustomerMemory | null;
  /** Deletions started here, updated until they complete. */
  deletions: MemoryDeletionReceipt[];
}

const POLL_MS = 1500;

/**
 * The customer's own memory (L04): what is remembered, their choice, and their corrections and
 * deletions. It follows the person on screen: a sign-in or sign-out loads the new person's memory
 * and drops the previous one's.
 */
export function useMemory(client: HamnivoClient, principalId: string | null) {
  const [state, setState] = useState<MemoryState>({
    phase: 'loading',
    memory: null,
    deletions: [],
  });
  const person = useRef(principalId);
  person.current = principalId;

  const load = useCallback(async () => {
    const owner = person.current;
    if (!owner) return;
    try {
      const memory = await client.getMemory();
      if (person.current === owner) setState((s) => ({ ...s, phase: 'ready', memory }));
    } catch {
      if (person.current === owner) setState((s) => ({ ...s, phase: 'error' }));
    }
  }, [client]);

  useEffect(() => {
    setState({ phase: 'loading', memory: null, deletions: [] });
    if (principalId) void load();
  }, [principalId, load]);

  // Deletions finish in the background (indexes and caches); follow them until they complete.
  const pending = state.deletions.filter((d) => d.status === 'pending').map((d) => d.id);
  const pendingKey = pending.join(',');
  useEffect(() => {
    if (!pendingKey) return;
    const owner = person.current;
    const timer = setInterval(() => {
      for (const id of pendingKey.split(',')) {
        void client
          .getMemoryDeletion(id)
          .then((receipt) => {
            if (person.current !== owner) return;
            setState((s) => ({
              ...s,
              deletions: s.deletions.map((d) => (d.id === receipt.id ? receipt : d)),
            }));
          })
          .catch(() => undefined);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [client, pendingKey]);

  const setConsent = useCallback(
    async (choice: 'granted' | 'declined' | 'withdrawn') => {
      await client.setMemoryConsent(choice, MEMORY_NOTICE_VERSION);
      await load();
    },
    [client, load],
  );

  const correct = useCallback(
    async (memoryId: string, value: string): Promise<MemoryChange> => {
      const change = await client.correctMemory(memoryId, value);
      await load();
      return change;
    },
    [client, load],
  );

  const confirm = useCallback(
    async (memoryId: string): Promise<MemoryChange> => {
      const change = await client.confirmMemory(memoryId);
      await load();
      return change;
    },
    [client, load],
  );

  const track = useCallback((receipt: MemoryDeletionReceipt) => {
    setState((s) => ({
      ...s,
      deletions: [receipt, ...s.deletions.filter((d) => d.id !== receipt.id)],
    }));
  }, []);

  const remove = useCallback(
    async (memoryId: string): Promise<MemoryDeletionReceipt> => {
      const receipt = await client.deleteMemory(memoryId);
      track(receipt);
      await load();
      return receipt;
    },
    [client, load, track],
  );

  const forget = useCallback(async (): Promise<MemoryDeletionReceipt> => {
    const receipt = await client.forgetMemory();
    track(receipt);
    await load();
    return receipt;
  }, [client, load, track]);

  return { state, reload: load, setConsent, correct, confirm, remove, forget };
}

export type MemoryControls = ReturnType<typeof useMemory>;
