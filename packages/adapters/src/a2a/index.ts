import { z } from 'zod';
import { type EgressPolicy, guardedFetch } from '../net/index.js';

/** A2A v1.0 HTTP+JSON binding. Verified against the primary specification 2026-10-20:
 * https://a2a-protocol.org/latest/specification/ (sections 3.6, 4.1, 10).
 * ACP is the former agent communication protocol; this is unrelated to commerce checkout.
 * Only explicit advisory text is sent. No conversation, customer identifier, local policy,
 * grants, tool credentials, or downstream delegation capability crosses this boundary.
 */
const Part = z.object({ text: z.string().max(16000).optional() }).passthrough();
const Message = z
  .object({ messageId: z.string(), role: z.literal('ROLE_AGENT'), parts: z.array(Part).max(32) })
  .passthrough();
const Task = z
  .object({
    id: z.string(),
    status: z
      .object({
        state: z.enum([
          'TASK_STATE_SUBMITTED',
          'TASK_STATE_WORKING',
          'TASK_STATE_COMPLETED',
          'TASK_STATE_FAILED',
          'TASK_STATE_CANCELED',
          'TASK_STATE_INPUT_REQUIRED',
          'TASK_STATE_REJECTED',
          'TASK_STATE_AUTH_REQUIRED',
        ]),
      })
      .passthrough(),
    artifacts: z
      .array(z.object({ parts: z.array(Part).max(32) }).passthrough())
      .max(32)
      .optional(),
  })
  .passthrough();
const SendResponse = z.union([z.object({ message: Message }), z.object({ task: Task })]);
export interface A2AAdvisoryResult {
  source: 'external_agent';
  trust: 'untrusted';
  taskId: string | null;
  state: 'completed' | 'input_required' | 'auth_required' | 'failed' | 'cancelled' | 'pending';
  text: string;
}
export class A2AError extends Error {
  constructor(
    readonly code: 'timeout' | 'aborted' | 'http' | 'invalid_response',
    message: string,
  ) {
    super(message);
    this.name = 'A2AError';
  }
}
export async function delegateA2A(input: {
  endpoint: string;
  policy: EgressPolicy;
  credential?: string;
  messageId: string;
  request: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<A2AAdvisoryResult> {
  const url = new URL(input.endpoint);
  // Endpoint is an administrator-selected A2A HTTP base URL. Agent cards cannot redirect auth.
  if (url.username || url.password || url.search || url.hash)
    throw new A2AError('http', 'Invalid A2A endpoint.');
  const fetcher =
    input.fetch ??
    guardedFetch(input.policy, { maxResponseBytes: 128 * 1024, refuseRedirects: true });
  const timeout = AbortSignal.timeout(Math.min(30000, Math.max(1, input.timeoutMs)));
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const response = await fetcher(`${url.href.replace(/\/$/, '')}/message:send`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'content-type': 'application/a2a+json',
        accept: 'application/a2a+json',
        'A2A-Version': '1.0',
        ...(input.credential ? { authorization: `Bearer ${input.credential}` } : {}),
      },
      body: JSON.stringify({
        message: {
          messageId: input.messageId,
          role: 'ROLE_USER',
          parts: [{ text: input.request.slice(0, 4000) }],
        },
        configuration: {
          acceptedOutputModes: ['text/plain'],
          returnImmediately: false,
          historyLength: 0,
        },
      }),
    });
    if (!response.ok) throw new A2AError('http', `A2A returned HTTP ${response.status}.`);
    const parsed = SendResponse.safeParse(await response.json());
    if (!parsed.success) throw new A2AError('invalid_response', 'A2A returned an invalid result.');
    if ('message' in parsed.data)
      return {
        source: 'external_agent',
        trust: 'untrusted',
        taskId: null,
        state: 'completed',
        text: parsed.data.message.parts
          .map((p) => p.text ?? '')
          .join('\n')
          .slice(0, 16000),
      };
    const task = parsed.data.task;
    const states: Record<string, A2AAdvisoryResult['state']> = {
      TASK_STATE_COMPLETED: 'completed',
      TASK_STATE_INPUT_REQUIRED: 'input_required',
      TASK_STATE_AUTH_REQUIRED: 'auth_required',
      TASK_STATE_FAILED: 'failed',
      TASK_STATE_REJECTED: 'failed',
      TASK_STATE_CANCELED: 'cancelled',
    };
    return {
      source: 'external_agent',
      trust: 'untrusted',
      taskId: task.id,
      state: states[task.status.state] ?? 'pending',
      text: (task.artifacts ?? [])
        .flatMap((a) => a.parts.map((p) => p.text ?? ''))
        .join('\n')
        .slice(0, 16000),
    };
  } catch (error) {
    if (timeout.aborted)
      throw new A2AError('timeout', 'The specialist did not respond before the deadline.');
    if (input.signal?.aborted) throw new A2AError('aborted', 'The delegation was cancelled.');
    throw error;
  } finally {
    if (!input.fetch && 'close' in fetcher)
      await (fetcher as ReturnType<typeof guardedFetch>).close();
  }
}
