import { BidiText } from './BidiText.js';

/**
 * Says, before the visitor writes anything, that this website notes which pages they view and how
 * to switch that off. The words come from the gateway in the visitor's language.
 */
export function VisitorNotice({
  text,
  className = 'mb-1 text-xs text-text-muted',
}: {
  text: string | null;
  className?: string;
}) {
  if (!text) return null;
  return (
    <p className={className} data-testid="visitor-notice">
      <BidiText text={text} />
    </p>
  );
}
