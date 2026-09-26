import type * as React from 'react';
import { cn } from '../lib/utils';

type LtrProps = React.ComponentProps<'bdi'> & { mono?: boolean };

/**
 * Isolates left-to-right tokens (order IDs, emails, amounts, code) inside right-to-left text so their
 * reading order survives Arabic/Urdu layouts (blueprint U04, W13).
 */
function Ltr({ mono = false, className, ...props }: LtrProps) {
  return <bdi dir="ltr" className={cn(mono && 'font-mono', className)} {...props} />;
}

/** Isolates user-generated text of unknown direction (names, message snippets). */
function Isolate(props: React.ComponentProps<'bdi'>) {
  return <bdi dir="auto" {...props} />;
}

export { Isolate, Ltr };
