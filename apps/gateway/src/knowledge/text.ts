/**
 * Plain-text preparation for knowledge: sanitize, then split into passages that keep their
 * heading, so a retrieved passage still says what it is about.
 */

export interface TextChunk {
  seq: number;
  heading: string | null;
  text: string;
  tokens: number;
}

/**
 * Rough token count that does not undercount non-Latin scripts: about four Latin characters per
 * token, about two for Arabic, Urdu or Devanagari.
 */
export function estimateTokens(text: string): number {
  let latin = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 0x0250) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4 + other / 2);
}

/** NFC, no control characters, normalized line breaks, bounded length. */
export function sanitizeText(input: string, maxChars = 1_000_000): string {
  return (
    input
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      // Control characters, zero-width spaces and byte-order marks carry no text.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\uFEFF]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, maxChars)
      .trim()
  );
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
// Sentence ends in Latin, Arabic/Urdu (؟ ۔) and Devanagari (। ॥) text.
const SENTENCE = /(?<=[.!?؟۔।॥])\s+/u;

function splitLong(paragraph: string, maxTokens: number): string[] {
  if (estimateTokens(paragraph) <= maxTokens) return [paragraph];
  const pieces: string[] = [];
  let current = '';
  for (const sentence of paragraph.split(SENTENCE)) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (current && estimateTokens(next) > maxTokens) {
      pieces.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) pieces.push(current);
  // A single sentence longer than the limit is cut by characters as a last resort.
  return pieces.flatMap((piece) => {
    if (estimateTokens(piece) <= maxTokens) return [piece];
    const size = Math.max(200, maxTokens * 2);
    const cut: string[] = [];
    for (let i = 0; i < piece.length; i += size) cut.push(piece.slice(i, i + size));
    return cut;
  });
}

/**
 * Splits text into passages of about `targetTokens`, never above `maxTokens`, grouped under the
 * nearest Markdown heading. The last paragraph of a passage starts the next one (overlap).
 */
export function chunkText(
  text: string,
  options: { targetTokens?: number; maxTokens?: number } = {},
): TextChunk[] {
  const target = options.targetTokens ?? 350;
  const max = options.maxTokens ?? 550;
  const chunks: TextChunk[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  // Paragraphs added since the last passage; overlap alone never makes a passage.
  let fresh = 0;

  const flush = (keepOverlap: boolean) => {
    if (fresh > 0) {
      const body = buffer.join('\n\n');
      chunks.push({ seq: chunks.length, heading, text: body, tokens: estimateTokens(body) });
    }
    const last = buffer.at(-1) ?? '';
    buffer = keepOverlap && fresh > 0 && estimateTokens(last) < target / 2 ? [last] : [];
    fresh = 0;
  };
  const add = (piece: string) => {
    buffer.push(piece);
    fresh += 1;
  };

  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const match = HEADING.exec(lines[0] ?? '');
    if (match) {
      flush(false);
      heading = match[2]?.trim() ?? null;
      const rest = lines.slice(1).join('\n').trim();
      if (!rest) continue;
      for (const piece of splitLong(rest, max)) add(piece);
      continue;
    }
    for (const piece of splitLong(trimmed, max)) {
      const candidate = [...buffer, piece].join('\n\n');
      if (fresh > 0 && estimateTokens(candidate) > max) flush(true);
      add(piece);
      if (estimateTokens(buffer.join('\n\n')) >= target) flush(true);
    }
  }
  flush(false);
  return chunks;
}
