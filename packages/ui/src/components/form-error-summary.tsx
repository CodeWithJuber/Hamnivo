import { AlertCircleIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';

export interface FieldError {
  /** id of the invalid input. */
  fieldId: string;
  message: string;
}

type FormErrorSummaryProps = React.ComponentProps<'div'> & {
  title: string;
  errors: FieldError[];
  /** Move focus to the summary when it appears after a submit attempt. */
  focusOnMount?: boolean;
};

/**
 * Linked error summary shown after a submit attempt (HNV-24-02). Each entry links to its field;
 * values are never cleared. Pair with `focusFirstInvalid` when the summary is not rendered.
 */
function FormErrorSummary({
  title,
  errors,
  focusOnMount = true,
  className,
  ...props
}: FormErrorSummaryProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focusOnMount && errors.length > 0) ref.current?.focus();
  }, [focusOnMount, errors.length]);
  if (errors.length === 0) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      data-slot="form-error-summary"
      className={cn(
        'flex gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-4',
        className,
      )}
      {...props}
    >
      <AlertCircleIcon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex flex-col gap-2">
        <p className="font-semibold text-danger">{title}</p>
        <ul className="flex list-disc flex-col gap-1 ps-4 text-sm">
          {errors.map((error) => (
            <li key={error.fieldId}>
              <a
                className="text-link underline underline-offset-4"
                href={`#${error.fieldId}`}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(error.fieldId)?.focus();
                }}
              >
                {error.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Focuses the first element marked aria-invalid inside `root`. */
function focusFirstInvalid(root: ParentNode = document): boolean {
  const first = root.querySelector<HTMLElement>('[aria-invalid="true"]');
  first?.focus();
  return Boolean(first);
}

export { FormErrorSummary, focusFirstInvalid };
