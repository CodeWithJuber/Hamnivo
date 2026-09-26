import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';
import { cn } from '../lib/utils';
import { Spinner } from './spinner';

/**
 * Button following the Hamnivo interaction-state contract (docs/design/UX-Flow-Specification.md §4):
 * default, hover, focus-visible, pressed, disabled, busy. Controls are ≥40px on desktop.
 * Use <ReasonedAction> to explain why an action is unavailable instead of a silent grey button.
 */
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-[var(--hv-motion-fast)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover active:translate-y-px',
        secondary:
          'border border-input bg-surface text-text hover:bg-surface-sunken active:bg-surface-sunken',
        outline:
          'border border-input bg-surface text-text hover:bg-surface-sunken active:bg-surface-sunken',
        ghost: 'text-text hover:bg-accent active:bg-accent',
        destructive:
          'border border-danger/25 bg-danger-subtle text-danger hover:border-danger/50 active:translate-y-px',
        'destructive-solid': 'bg-danger text-on-danger hover:bg-danger/90 active:translate-y-px',
        brand:
          'bg-brand-strong text-on-brand-strong hover:bg-brand-strong/90 active:translate-y-px',
        link: 'h-auto px-0 text-link underline underline-offset-4 hover:no-underline',
      },
      size: {
        default: 'h-10 px-4 has-[>svg]:px-3',
        /** Dense contexts only (table row actions, inline chips). */
        sm: 'h-9 gap-1.5 px-3 has-[>svg]:px-2.5',
        /** Touch-first surfaces: 44px target. */
        lg: 'h-11 px-6 has-[>svg]:px-4',
        icon: 'size-10',
        'icon-sm': 'size-9',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /**
     * Busy state: keeps the label (with a spinner), exposes aria-busy and ignores further clicks so
     * a slow request cannot be submitted twice.
     */
    busy?: boolean;
  };

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  busy = false,
  onClick,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (busy || props['aria-disabled'] === true || props['aria-disabled'] === 'true') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick?.(event);
    },
    [busy, onClick, props['aria-disabled']],
  );

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-busy={busy || undefined}
      aria-busy={busy || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={handleClick}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {busy ? <Spinner aria-hidden="true" /> : null}
          {children}
        </>
      )}
    </Comp>
  );
}

export { Button, type ButtonProps, buttonVariants };
