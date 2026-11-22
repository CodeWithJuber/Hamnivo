/**
 * The models a key can use, read live from the provider through the gateway, for the model field.
 * A pasted key (not saved yet) is sent once to read the list and is never kept here: the cache
 * entry is named by the key's length and last four characters, as Studio shows a saved key, and
 * dropped as soon as nothing reads it.
 */
import type { ListModelsRequest, ModelList } from '@hamnivo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';
import { useTenant } from './tenant';

export type { ListModelsRequest, ModelList };

/** The gateway keeps a provider's list ten minutes; Studio asks again no sooner. */
const FRESH_MS = 10 * 60_000;

function cacheKey(request: ListModelsRequest): readonly unknown[] {
  switch (request.source) {
    case 'connection':
      return ['provider-models', 'connection', request.connectionId];
    case 'platform':
      return ['provider-models', 'platform', request.provider];
    case 'key':
      return [
        'provider-models',
        'key',
        request.provider,
        request.baseUrl ?? '',
        request.apiKey?.length ?? 0,
        request.apiKey?.slice(-4) ?? '',
      ];
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
  const queryKey = [tenantId, ...(request ? cacheKey(request) : ['provider-models', 'none'])];
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
    gcTime: pasted ? 0 : FRESH_MS,
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
