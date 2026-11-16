/**
 * Questions a customer might ask next, offered under the newest AI answer as chips. The job that
 * asks a model for them sends instructions that start with this marker, then the conversation's
 * last turn; the model answers with one short question per line. What comes back is only a
 * suggestion: `followUpsOf` keeps at most three short, plain questions and drops anything else.
 */
export const FOLLOW_UPS_MARKER = 'hamnivo:follow-ups:v1';

/** At most this many are offered, each at most this long. */
export const FOLLOW_UPS_MAX = 3;
export const FOLLOW_UP_MAX_LENGTH = 120;

/** A model's answer → the questions worth offering: trimmed, unnumbered, short, distinct. */
export function followUpsOf(text: string): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      // Numbering, bullets and quotes a model adds around the questions.
      .replace(/^(?:[-*•·]|\d{1,2}[.)])\s*/, '')
      .replace(/^["“'«]+|["”'»]+$/g, '')
      .trim();
    // A question to ask, not instructions or a link to follow.
    if (line.length < 3 || line.length > FOLLOW_UP_MAX_LENGTH) continue;
    if (/https?:|www\.|@|[<>{}[\]]/i.test(line)) continue;
    const key = line.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
    if (kept.length === FOLLOW_UPS_MAX) break;
  }
  return kept;
}

/** The deterministic stand-in for tests and the mock provider: two questions in the reply's script. */
export function mockFollowUps(answer: string): string {
  if (/[؀-ۿ]/.test(answer)) return 'متى يصل طلبي؟\nهل يمكنني تغيير العنوان؟';
  if (/[ऀ-ॿ]/.test(answer)) return 'मेरा ऑर्डर कब आएगा?\nक्या मैं पता बदल सकता हूँ?';
  return 'When will my order arrive?\nCan I change the delivery address?';
}
