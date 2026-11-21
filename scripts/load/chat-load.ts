/**
 * Load on the chat (production-ready plan: 1,000 open event streams and 50 messages a second).
 * Each simulated visitor opens a session, starts a conversation and keeps its event stream open;
 * meanwhile messages go out at a steady rate from visitors picked in turn. It reports how long
 * streams took to open, how long each message took to be accepted, and how long until the
 * visitor's own stream carried it back.
 *
 * Run it against a test server only: every visitor is a real conversation there. The server's
 * per-address limit (RATE_LIMIT_PER_MINUTE, 600 by default) must allow the rate from one machine.
 *
 *   pnpm exec tsx scripts/load/chat-load.ts --api http://127.0.0.1:5181 --widget wid_… \
 *     --chat http://127.0.0.1:5182 --origin https://shop.example --streams 1000 --rate 50 --seconds 60
 *
 * --chat is where the chat's frame is served (the browser sends it as Origin); --origin is the
 * website the chat is on, one of the brand's allowed websites.
 *
 * k6 holds a streaming response only with its xk6-sse extension, a custom build; Node's own fetch
 * streams the events with nothing to install. Exit code 1 when a target is missed: a stream that
 * did not open, under 95% of the messages accepted, a failed request or lost message, or p95
 * latency over --max-accept-p95 (1000 ms) or --max-echo-p95 (2000 ms).
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    api: { type: 'string' },
    widget: { type: 'string' },
    chat: { type: 'string' },
    origin: { type: 'string' },
    streams: { type: 'string', default: '1000' },
    rate: { type: 'string', default: '50' },
    seconds: { type: 'string', default: '60' },
    /** Visitors opening at the same time while the streams come up. */
    ramp: { type: 'string', default: '50' },
    /** Slowest accepted message allowed, at the 95th percentile; slower means a queue builds. */
    'max-accept-p95': { type: 'string', default: '1000' },
    /** Slowest message allowed back on its own stream, at the 95th percentile. */
    'max-echo-p95': { type: 'string', default: '2000' },
  },
});

if (!values.api || !values.widget || !values.chat || !values.origin) {
  console.error(
    'Name the test server: --api URL --widget wid_… --chat CHAT_URL --origin https://allowed.site',
  );
  process.exit(2);
}
const chat = values.chat.replace(/\/+$/, '');
const api = values.api.replace(/\/+$/, '');
const streams = Number(values.streams);
const rate = Number(values.rate);
const seconds = Number(values.seconds);
const ramp = Number(values.ramp);

interface Visitor {
  token: string;
  conversationId: string;
  /** Messages sent and not yet seen on the stream: clientMessageId → time sent. */
  waiting: Map<string, number>;
  abort: AbortController;
}

const opened: number[] = [];
const accepted: number[] = [];
const echoed: number[] = [];
const errors = new Map<string, number>();
const fail = (what: string) => errors.set(what, (errors.get(what) ?? 0) + 1);

async function call(path: string, token: string | null, body: unknown): Promise<Response> {
  return fetch(`${api}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: chat,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Reads the stream until it is aborted, noting when the visitor's own messages come back. */
async function listen(visitor: Visitor, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  // The end of the previous chunk, so an id split between two chunks is still found.
  let tail = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const text = tail + value;
      tail = text.slice(-64);
      for (const [id, sentAt] of visitor.waiting) {
        if (text.includes(id)) {
          echoed.push(performance.now() - sentAt);
          visitor.waiting.delete(id);
        }
      }
    }
  } catch (error) {
    if (!visitor.abort.signal.aborted) fail(`stream: ${(error as Error).name}`);
  }
}

async function open(): Promise<Visitor | null> {
  const started = performance.now();
  const session = await call('/v1/widget/sessions', null, {
    widgetId: values.widget,
    hostOrigin: values.origin,
  });
  if (!session.ok) {
    fail(`session ${session.status}`);
    return null;
  }
  const { accessToken } = (await session.json()) as { accessToken: string };
  const conversation = await call('/v1/widget/conversations', accessToken, {});
  if (!conversation.ok) {
    fail(`conversation ${conversation.status}`);
    return null;
  }
  const { id } = (await conversation.json()) as { id: string };
  const visitor: Visitor = {
    token: accessToken,
    conversationId: id,
    waiting: new Map(),
    abort: new AbortController(),
  };
  const events = await fetch(`${api}/v1/widget/conversations/${encodeURIComponent(id)}/events`, {
    headers: {
      accept: 'text/event-stream',
      authorization: `Bearer ${accessToken}`,
      origin: chat,
    },
    signal: visitor.abort.signal,
  });
  if (!events.ok || !events.body) {
    fail(`stream ${events.status}`);
    return null;
  }
  opened.push(performance.now() - started);
  void listen(visitor, events.body);
  return visitor;
}

async function send(visitor: Visitor): Promise<void> {
  const clientMessageId = randomUUID();
  const sentAt = performance.now();
  visitor.waiting.set(clientMessageId, sentAt);
  const response = await call(
    `/v1/widget/conversations/${encodeURIComponent(visitor.conversationId)}/messages`,
    visitor.token,
    { clientMessageId, parts: [{ type: 'text', text: `Load test ${clientMessageId}` }] },
  ).catch(() => null);
  if (!response?.ok) {
    visitor.waiting.delete(clientMessageId);
    return fail(`message ${response?.status ?? 'network'}`);
  }
  accepted.push(performance.now() - sentAt);
  await response.body?.cancel();
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
};
const ms = (value: number) => (Number.isNaN(value) ? '–' : `${Math.round(value)} ms`);

const visitors: Visitor[] = [];
for (let next = 0; next < streams; next += ramp) {
  const batch = await Promise.all(
    Array.from({ length: Math.min(ramp, streams - next) }, () =>
      open().catch((error: Error) => {
        fail(`open: ${error.name}`);
        return null;
      }),
    ),
  );
  for (const visitor of batch) if (visitor) visitors.push(visitor);
}
console.log(`${visitors.length} of ${streams} streams open`);

let turn = 0;
const sends: Promise<void>[] = [];
const ticker = setInterval(() => {
  const visitor = visitors[turn++ % Math.max(1, visitors.length)];
  if (visitor) sends.push(send(visitor));
}, 1000 / rate);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(ticker);
await Promise.all(sends);
// Give the last messages a moment to come back on their streams.
await new Promise((resolve) => setTimeout(resolve, 3000));
const lost = visitors.reduce((sum, visitor) => sum + visitor.waiting.size, 0);
for (const visitor of visitors) visitor.abort.abort();

const rows = [
  ['streams open', `${visitors.length} / ${streams}`],
  ['stream open p50 / p95', `${ms(percentile(opened, 50))} / ${ms(percentile(opened, 95))}`],
  ['messages accepted', `${accepted.length} (${(accepted.length / seconds).toFixed(1)}/s)`],
  ['accepted p50 / p95 / p99', [50, 95, 99].map((p) => ms(percentile(accepted, p))).join(' / ')],
  ['back on its stream p50 / p95', `${ms(percentile(echoed, 50))} / ${ms(percentile(echoed, 95))}`],
  ['sent but never seen on the stream', String(lost)],
  ['errors', errors.size ? [...errors].map(([k, v]) => `${k} × ${v}`).join(', ') : 'none'],
];
for (const [name, value] of rows) console.log(`${name.padEnd(34)} ${value}`);

const misses = [
  visitors.length < streams && `${streams - visitors.length} streams did not open`,
  accepted.length < rate * seconds * 0.95 && 'fewer than 95% of the messages were accepted',
  errors.size > 0 && 'requests failed',
  lost > 0 && `${lost} messages never came back on their stream`,
  percentile(accepted, 95) > Number(values['max-accept-p95']) &&
    `accepting a message took over ${values['max-accept-p95']} ms at p95: a queue built up`,
  percentile(echoed, 95) > Number(values['max-echo-p95']) &&
    `a message took over ${values['max-echo-p95']} ms at p95 to come back on its stream`,
].filter(Boolean);
for (const miss of misses) console.log(`MISSED: ${miss}`);
process.exit(misses.length > 0 ? 1 : 0);
