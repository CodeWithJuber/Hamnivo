/**
 * The models a key can use, read live from the provider through the gateway, for the model field.
 * A pasted key (not saved yet) is sent once to read the list and is never kept here: its cache
 * entry is named by a number that changes whenever the pasted values change, never by any part of
 * the key, and is dropped as soon as nothing reads it.
 */
import type { ListModelsRequest, ModelList } from '@hamnivo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api';
import { useTenant } from './tenant';

export type { ListModelsRequest, ModelList };

/** The gateway keeps a provider's list ten minutes; Studio asks again no sooner. */
const FRESH_MS = 10 * 60_000;

function cacheKey(request: ListModelsRequest, pasted: string): readonly unknown[] {
  switch (request.source) {
    case 'connection':
      return ['provider-models', 'connection', request.connectionId];
    case 'platform':
      return ['provider-models', 'platform', request.provider];
    case 'key':
      return ['provider-models', 'key', pasted];
  }
}

/**
 * The live list for a key, or nothing while there is no key to ask with (`request` null) or the
 * person may not manage AI keys. A refusal (a bad address, no server key) is an error; a provider
 * that would not list is an answer with `ok: false`.
 */
export function useProviderModels(request: ListModelsRequest | null) {
  const { tenantId, can } = useTenant();
  const client = useQueryClient();
  const enabled = request !== null && can('integrations.manage');
  const pasted = request?.source === 'key';
  // Each new set of pasted values gets the next number in this field.
  const field = useId();
  const last = useRef({ values: '', count: 0 });
  const values = JSON.stringify(request);
  if (last.current.values !== values) last.current = { values, count: last.current.count + 1 };
  const queryKey = [
    tenantId,
    ...(request
      ? cacheKey(request, `${field}:${last.current.count}`)
      : ['provider-models', 'none']),
  ];
  const gcTime = pasted ? 0 : FRESH_MS;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api<ModelList>('/v1/admin/model-connections/models', {
        method: 'POST',
        tenant: tenantId,
        body: request,
        signal,
      }),
    meta: { studio: true },
    enabled,
    staleTime: FRESH_MS,
    // A pasted key's list is forgotten as soon as the field is gone.
    gcTime,
    retry: false,
    refetchOnWindowFocus: false,
  });
  /** Asks the provider again, past the gateway's ten-minute memory of a saved key's list. */
  const refresh = async () => {
    if (!request || !enabled) return;
    await client
      .fetchQuery({
        queryKey,
        queryFn: ({ signal }) =>
          api<ModelList>('/v1/admin/model-connections/models', {
            method: 'POST',
            tenant: tenantId,
            body: request.source === 'key' ? request : { ...request, refresh: true },
            signal,
          }),
        staleTime: 0,
        gcTime,
      })
      // A failed refresh leaves the error on the query, where the field shows it.
      .catch(() => undefined);
  };
  return { ...query, refresh };
}

/**
 * The value once it has stopped changing for `ms`, so a key being typed or pasted is sent once,
 * not on every keystroke. For plain JSON values (such as a request body), compared by contents.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  const serialized = JSON.stringify(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(JSON.parse(serialized) as T), ms);
    return () => clearTimeout(timer);
  }, [serialized, ms]);
  return settled;
}
