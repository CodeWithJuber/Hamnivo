import { useCallback, useRef, useState } from 'react';
import { type ModelProbeResult, useTestConnection } from '../../lib/setup';

/**
 * Runs the test of a connection and keeps its outcome. A test that finishes after a newer one was
 * started is dropped, so an answer on screen is always for the latest request.
 */
export function useConnectionTest() {
  const mutation = useTestConnection();
  const [result, setResult] = useState<ModelProbeResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);
  const { mutateAsync } = mutation;

  const run = useCallback(
    async (connectionId: string, modelId?: string) => {
      const mine = ++latest.current;
      setResult(null);
      setError(null);
      try {
        const outcome = await mutateAsync({ connectionId, modelId });
        if (mine === latest.current) setResult(outcome);
      } catch (caught) {
        if (mine === latest.current) setError(caught);
      }
    },
    [mutateAsync],
  );

  return { run, result, error, pending: mutation.isPending };
}
