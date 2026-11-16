import { Button } from '@hamnivo/ui/components/button';
import { ArrowLeftIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

/**
 * The top of a screen opened from the chat (settings, the visitor's conversations): the way back
 * and the screen's name. Focus moves to the name when the screen opens, so a screen reader says
 * where the visitor now is and the keyboard goes on from the top of it.
 */
export function SubHeader(props: {
  title: string;
  titleId: string;
  back: string;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="-ms-2 size-10 shrink-0"
        aria-label={props.back}
        title={props.back}
        onClick={props.onBack}
      >
        <ArrowLeftIcon className="size-5 rtl:rotate-180" aria-hidden="true" />
      </Button>
      <h2
        ref={heading}
        id={props.titleId}
        tabIndex={-1}
        className="min-w-0 break-words text-md font-semibold text-text outline-none"
      >
        {props.title}
      </h2>
    </div>
  );
}
