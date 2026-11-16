import { ParticipantAvatar, type ParticipantKind } from '@hamnivo/ui/components/participant-badge';
import { useState } from 'react';

/**
 * The picture beside a sender's turn: their own when the gateway has one, the brand's logo for
 * its assistant, otherwise initials or a glyph by kind. It is decoration: the sender's name and
 * role are always written next to it, so who is writing never rests on a picture (W04).
 */
export function Avatar(props: {
  kind: ParticipantKind;
  name: string;
  /** The sender's own picture. */
  url?: string | null | undefined;
  /** The brand's logo, used for the brand's assistant. */
  logoUrl?: string | null | undefined;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const logo = props.kind === 'ai_primary' ? props.logoUrl : null;
  const src = props.url ?? logo ?? null;
  if (!src || failed === src) return <ParticipantAvatar kind={props.kind} name={props.name} />;
  return (
    <img
      src={src}
      alt=""
      width={32}
      height={32}
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
      className={`size-8 shrink-0 rounded-full border border-border bg-surface ${
        props.url ? 'object-cover' : 'object-contain p-1'
      }`}
    />
  );
}
