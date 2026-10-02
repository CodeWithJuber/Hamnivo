import { bidiSegments, textDirection } from '@hamnivo/domain';
import { Ltr } from '@hamnivo/ui/components/bidi';
import { Fragment } from 'react';

/**
 * The direction a message reads in (U08): right to left when most of its letters are Arabic
 * script, whatever the interface language. Text without letters follows its surroundings.
 */
export const directionOf = (text: string): 'rtl' | 'ltr' | 'auto' => textDirection(text) ?? 'auto';

/**
 * Plain text with order numbers, amounts, emails and links isolated left to right, so they keep
 * their order inside a right-to-left sentence. Copying gives back the text unchanged.
 */
export function BidiText({ text }: { text: string }) {
  let offset = 0;
  return (
    <>
      {bidiSegments(text).map((segment) => {
        const at = offset;
        offset += segment.text.length;
        return segment.isolate ? (
          <Ltr key={at}>{segment.text}</Ltr>
        ) : (
          <Fragment key={at}>{segment.text}</Fragment>
        );
      })}
    </>
  );
}
