import { Button } from '@hamnivo/ui/components/button';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { RotateCwIcon } from 'lucide-react';

/**
 * The chat while it starts: the shape of what is coming, so the frame is never an empty box.
 * The words are for screen readers; the grey shapes say nothing by themselves.
 */
export function ChatSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col bg-bg" role="status" data-testid="chat-loading">
      <span className="sr-only">{label}</span>
      <div
        className="flex items-center gap-3 border-b border-border bg-surface px-3 py-3"
        aria-hidden="true"
      >
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ms-auto size-8 rounded-lg" />
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-5"
        aria-hidden="true"
      >
        <Skeleton className="h-16 w-3/4 rounded-xl" />
        <Skeleton className="ms-auto h-10 w-1/2 rounded-xl" />
        <Skeleton className="h-24 w-4/5 rounded-xl" />
      </div>
      <div className="border-t border-border bg-surface p-3" aria-hidden="true">
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    </div>
  );
}

/**
 * The chat could not start. The reason is said once, as an alert; trying again is one press and
 * starts from the beginning.
 */
export function StartError(props: { message: string; retry: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg p-6 text-center">
      <p className="text-sm text-text" role="alert">
        {props.message}
      </p>
      <Button variant="secondary" onClick={props.onRetry} data-testid="start-retry">
        <RotateCwIcon className="size-4" aria-hidden="true" />
        {props.retry}
      </Button>
    </div>
  );
}
