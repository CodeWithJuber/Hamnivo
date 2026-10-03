import { useState } from 'react';

/**
 * The brand's logo at the start of the chat's header, when it has one. The brand's name is in the
 * header as text, so the picture is decoration: no alternative text, and no empty space where it
 * would have been if it cannot be loaded.
 */
export function BrandMark({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <img
      src={url}
      alt=""
      width={36}
      height={36}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-9 shrink-0 rounded-md object-contain"
      data-testid="brand-logo"
    />
  );
}
