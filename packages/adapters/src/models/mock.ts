import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import {
  type ExtractionInput,
  MEMORY_EXTRACTION_MARKER,
  mockExtractMemories,
} from '@hamnivo/domain';

export interface MockTurn {
  /** System instructions, joined. */
  system: string;
  /** Text of the latest user message. */
  text: string;
  /** Number of user messages so far, including this one. */
  turn: number;
}

export type MockReply = (turn: MockTurn) => string;

const words = (value: string) => value.split(/\s+/).filter(Boolean).length;

function usageOf(input: string, output: string): LanguageModelV4Usage {
  return {
    inputTokens: { total: words(input), noCache: words(input), cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: words(output), text: words(output), reasoning: 0 },
  };
}

function turnOf(prompt: LanguageModelV4Prompt): MockTurn {
  const system = prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const users = prompt.filter((m) => m.role === 'user');
  const last = users.at(-1);
  const text =
    last?.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')
      .trim() ?? '';
  return { system, text, turn: users.length };
}

type Script = 'arabic' | 'urdu' | 'devanagari' | 'latin';

/** Urdu uses letters that Arabic does not (ٹ ڈ ڑ ں ے ھ ک گ پ چ). */
function scriptOf(text: string): Script {
  if (/[ٹڈڑںےھکگپچ]/.test(text)) return 'urdu';
  if (/[؀-ۿ]/.test(text)) return 'arabic';
  if (/[ऀ-ॿ]/.test(text)) return 'devanagari';
  return 'latin';
}

const GREETING = /\b(assalamu?|salaam?|asalam)\b|السلام|السّلام/i;

const REPLIES: Record<Script, { greeting: string; body: string }> = {
  latin: {
    greeting: 'Wa alaikum assalam! ',
    body: 'Thank you for your message. I am an AI assistant. Please share a few more details (for example an order number) and I will help, or ask for a person at any time.',
  },
  arabic: {
    greeting: 'وعليكم السلام! ',
    body: 'شكراً لرسالتك. أنا مساعد ذكاء اصطناعي. يرجى مشاركة مزيد من التفاصيل (مثل رقم الطلب) وسأساعدك، أو اطلب التحدث إلى شخص في أي وقت.',
  },
  urdu: {
    greeting: 'وعلیکم السلام! ',
    body: 'آپ کے پیغام کا شکریہ۔ میں ایک اے آئی اسسٹنٹ ہوں۔ براہ کرم مزید تفصیل (جیسے آرڈر نمبر) بتائیں تو میں مدد کروں گا، یا کسی بھی وقت کسی شخص سے بات کرنے کا کہیں۔',
  },
  devanagari: {
    greeting: 'वअलैकुम अस्सलाम! ',
    body: 'आपके संदेश के लिए धन्यवाद। मैं एक एआई सहायक हूँ। कृपया थोड़ी और जानकारी (जैसे ऑर्डर नंबर) दें, मैं मदद करूँगा, या किसी भी समय किसी व्यक्ति से बात करने के लिए कहें।',
  },
};

/**
 * Memory extraction (instructions carry MEMORY_EXTRACTION_MARKER): proposes only what the
 * customer stated explicitly, deterministically, as the JSON the extraction job expects.
 */
function mockMemoryExtraction(text: string): string {
  let input: ExtractionInput = { messages: [] };
  try {
    const parsed = JSON.parse(text) as Partial<ExtractionInput>;
    if (Array.isArray(parsed.messages)) input = { messages: parsed.messages };
  } catch {
    // Not the extraction input: nothing to propose.
  }
  return JSON.stringify({ memories: mockExtractMemories(input) });
}

/**
 * Default reply: answers in the customer's script, returns a greeting of peace, says plainly that
 * it is an AI and asks for details. It claims no facts it does not have.
 */
export const defaultMockReply: MockReply = ({ system, text }) => {
  if (system.includes(MEMORY_EXTRACTION_MARKER)) return mockMemoryExtraction(text);
  const reply = REPLIES[scriptOf(text)];
  return `${GREETING.test(text) ? reply.greeting : ''}${reply.body}`;
};

/**
 * `hamnivo-mock`: a deterministic, offline language model with the AI SDK V4 interface, used when
 * no provider key is configured, in tests and in evaluations. It never calls the network.
 */
export function createMockModel(
  options: { modelId?: string; reply?: MockReply; chunkWords?: number } = {},
): LanguageModelV4 {
  const reply = options.reply ?? defaultMockReply;
  const chunkWords = options.chunkWords ?? 3;
  const run = (call: LanguageModelV4CallOptions) => {
    const turn = turnOf(call.prompt);
    return { turn, output: reply(turn) };
  };
  return {
    specificationVersion: 'v4',
    provider: 'hamnivo',
    modelId: options.modelId ?? 'hamnivo-mock',
    supportedUrls: {},
    async doGenerate(call): Promise<LanguageModelV4GenerateResult> {
      call.abortSignal?.throwIfAborted();
      const { turn, output } = run(call);
      return {
        content: [{ type: 'text', text: output }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usageOf(`${turn.system} ${turn.text}`, output),
        warnings: [],
      };
    },
    async doStream(call) {
      call.abortSignal?.throwIfAborted();
      const { turn, output } = run(call);
      const pieces = output.split(/(?<=\s)/);
      const parts: LanguageModelV4StreamPart[] = [{ type: 'text-start', id: 't0' }];
      for (let i = 0; i < pieces.length; i += chunkWords) {
        parts.push({
          type: 'text-delta',
          id: 't0',
          delta: pieces.slice(i, i + chunkWords).join(''),
        });
      }
      parts.push({ type: 'text-end', id: 't0' });
      parts.push({
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usageOf(`${turn.system} ${turn.text}`, output),
      });
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
      return { stream };
    },
  };
}
