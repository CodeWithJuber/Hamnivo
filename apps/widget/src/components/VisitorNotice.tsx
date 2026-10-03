import { BidiText } from './BidiText.js';

/**
 * Says, before the visitor writes anything, that this website notes which pages they view and how
 * to switch that off. The words come from the gateway in the visitor's language.
 */
export function VisitorNotice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mb-1 text-xs text-text-muted" data-testid="visitor-notice">
      <BidiText text={text} />
    </p>
  );
}
