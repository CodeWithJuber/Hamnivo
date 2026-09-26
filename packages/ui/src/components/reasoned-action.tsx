import * as React from 'react';
import { cn } from '../lib/utils';

type ReasonedActionProps = {
  /** When set, the action is unavailable and this text explains what unlocks it (HNV-24-02). */
  reason?: string | null;
  /** A single interactive element, usually a <Button>. */
  children: React.ReactElement<{
    'aria-disabled'?: boolean;
    'aria-describedby'?: string;
    onClick?: (event: React.MouseEvent) => void;
  }>;
  className?: string;
};

/**
 * Shows why an action is unavailable next to it, instead of a silent grey button.
 * The control stays focusable (aria-disabled rather than disabled) so keyboard and screen-reader
 * users can discover the reason, and activation is blocked.
 */
function ReasonedAction({ reason, children, className }: ReasonedActionProps) {
  const reasonId = React.useId();
  if (!reason) return children;
  const child = React.cloneElement(children, {
    'aria-disabled': true,
    'aria-describedby': [children.props['aria-describedby'], reasonId].filter(Boolean).join(' '),
    onClick: (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    },
  });
  return (
    <span
      data-slot="reasoned-action"
      className={cn('inline-flex flex-col items-start gap-1', className)}
    >
      {child}
      <span id={reasonId} className="text-xs text-danger">
        {reason}
      </span>
    </span>
  );
}

export { ReasonedAction };
