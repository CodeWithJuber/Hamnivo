import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from '@ai-sdk/provider';

/**
 * Deterministic tool use for `hamnivo-mock` (tests, simulations and demos). The mock picks the
 * offered tool whose name best matches the customer's words and fills its arguments from the text
 * by schema (references like NL-1048, an address after "to", an amount, a currency, an enum
 * value). It calls at most one tool per customer message, and after a tool result writes a short
 * honest reply from the result's own status and summary, never from the tool's data.
 */

export interface ToolPlan {
  toolName: string;
  input: Record<string, unknown>;
}

/** Words that do not identify a tool. */
const NOISE = new Set(['demo', 'get', 'read', 'tool', 'do', 'the', 'a', 'of', 'for', 'my']);
/** Words customers use for a tool word. */
const SYNONYMS: Record<string, string[]> = {
  status: ['status', 'where', 'track', 'tracking'],
  update: ['update', 'change', 'modify'],
  cancel: ['cancel', 'stop'],
  credit: ['credit', 'compensation'],
  lookup: ['lookup', 'look', 'find', 'check'],
};

const REFERENCE = /\b[A-Z]{2,5}-[A-Z0-9]{3,12}\b/;
const CURRENCY = /\b[A-Z]{3}\b/g;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function score(toolName: string, words: Set<string>): number {
  let matched = 0;
  for (const part of toolName.toLowerCase().split(/[_\-.]+/)) {
    if (!part || NOISE.has(part)) continue;
    const forms = SYNONYMS[part] ?? [part];
    if (forms.some((form) => [...words].some((w) => w === form || w.startsWith(form)))) {
      matched += 1;
    }
  }
  return matched;
}

interface PropertySchema {
  type?: string | string[];
  enum?: unknown[];
  maxLength?: number;
}

function extract(name: string, schema: PropertySchema, text: string): unknown {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  const withoutRefs = text.replace(new RegExp(REFERENCE.source, 'g'), ' ');
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const lower = text.toLowerCase();
    return schema.enum.find((v) => typeof v === 'string' && lower.includes(v.toLowerCase()));
  }
  if (type === 'string') {
    if (/(reference|ref|order|booking|number|code)$/i.test(name) || /id$/i.test(name)) {
      return text.match(REFERENCE)?.[0];
    }
    if (/address/i.test(name)) {
      const after = text
        .split(/\s+to\s+/i)
        .slice(1)
        .join(' to ');
      const value = after.replace(/[.!?؟]+\s*$/, '').trim();
      return value || undefined;
    }
    if (/currency/i.test(name)) return withoutRefs.match(CURRENCY)?.[0];
    return text.slice(0, schema.maxLength ?? 500);
  }
  if (type === 'integer' || type === 'number') {
    const number = withoutRefs.match(/\b\d{1,12}\b/)?.[0];
    return number === undefined ? undefined : Number(number);
  }
  if (type === 'boolean') return undefined;
  return undefined;
}

/** The tool call the mock makes for a customer's words, or null. */
export function planToolCall(
  text: string,
  tools: readonly LanguageModelV4FunctionTool[],
): ToolPlan | null {
  const words = new Set(wordsOf(text));
  const ranked = [...tools]
    .map((tool) => ({ tool, score: score(tool.name, words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  for (const { tool } of ranked) {
    const schema = tool.inputSchema as {
      properties?: Record<string, PropertySchema>;
      required?: string[];
    };
    const input: Record<string, unknown> = {};
    let complete = true;
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const value = extract(name, property, text);
      if (value !== undefined) input[name] = value;
      else if (schema.required?.includes(name)) complete = false;
    }
    if (complete) return { toolName: tool.name, input };
  }
  return null;
}

/** The fenced result the gateway returned for a tool call, when it has the expected shape. */
export interface SeenToolResult {
  status: string;
  summary: string;
  data?: unknown;
}

export function lastToolResult(prompt: LanguageModelV4Prompt): SeenToolResult | null {
  const last = prompt.at(-1);
  if (last?.role !== 'tool') return null;
  const part = [...last.content].reverse().find((p) => p.type === 'tool-result');
  if (part?.type !== 'tool-result') return null;
  const output: LanguageModelV4ToolResultOutput = part.output;
  switch (output.type) {
    case 'json': {
      const value = output.value as Record<string, unknown> | null;
      if (value && typeof value === 'object' && typeof value.status === 'string') {
        return {
          status: value.status,
          summary: typeof value.summary === 'string' ? value.summary : '',
          ...(value.data !== undefined ? { data: value.data } : {}),
        };
      }
      return { status: 'ok', summary: '' };
    }
    case 'execution-denied':
      return { status: 'denied', summary: 'The action was not allowed.' };
    case 'error-text':
    case 'error-json':
      return { status: 'failed', summary: 'The tool failed.' };
    default:
      return { status: 'ok', summary: '' };
  }
}

/** The mock's reply after a tool result: what the result says, nothing more. */
export function replyAfterTool(result: SeenToolResult): string {
  const summary = result.summary.trim().replace(/[.]?$/, '.');
  switch (result.status) {
    case 'ok':
      return `Here is what I found: ${summary}`;
    case 'completed':
      return `Done: ${summary}`;
    case 'awaiting_approval':
      return `${summary} Nothing has changed yet.`;
    case 'unknown':
      return `${summary} The request was sent, but the result is not confirmed yet. We are checking before trying again.`;
    default:
      return `I could not do that: ${summary} A person can help if you need.`;
  }
}
