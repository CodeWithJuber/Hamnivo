import type { Meta, StoryObj } from '@storybook/react-vite';
import { toast } from 'sonner';
import {
  EmptyState,
  LoadingRegion,
  PartialFailure,
  RecoverableError,
} from '../components/async-states';
import { Button } from '../components/button';
import { ProgressStatus } from '../components/progress-status';
import { Skeleton } from '../components/skeleton';

/** HNV-24-03 Async content — loading, empty and skeleton; plus success, progress and partial failure. */
const meta = { title: 'Interaction states/Async content (HNV-24-03)' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const listSkeleton = (
  <div className="flex flex-col gap-3">
    {[0, 1, 2].map((i) => (
      <div key={i} className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

export const Loading: Story = {
  render: () => (
    <div className="max-w-md rounded-lg border border-border bg-surface p-4">
      <LoadingRegion loading label="Loading conversations" skeleton={listSkeleton}>
        {null}
      </LoadingRegion>
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="grid max-w-md gap-4">
      <EmptyState
        kind="no-records"
        title="No assigned conversations"
        description="Conversations assigned to you will appear here."
        action={<Button>View unassigned</Button>}
      />
      <EmptyState
        kind="no-matches"
        title="No conversations match these filters"
        description="Remove a filter to see more results."
        action={<Button variant="secondary">Reset filters</Button>}
      />
    </div>
  ),
};

export const ErrorAndPartialFailure: Story = {
  render: () => (
    <div className="grid max-w-xl gap-4">
      <RecoverableError
        title="Unable to load conversations"
        description="There was a problem loading conversations. Check your connection and try again."
        retryLabel="Retry"
        onRetry={() => {}}
        reference="req_01J9Z4K7"
      />
      <PartialFailure
        succeeded={18}
        failed={2}
        summary="18 conversations assigned. 2 could not be assigned because another agent claimed them first."
        retryFailedLabel="Review 2"
        onRetryFailed={() => {}}
      />
    </div>
  ),
};

export const SuccessToastAndProgress: Story = {
  render: () => (
    <div className="grid max-w-md gap-4">
      <Button
        variant="secondary"
        onClick={() =>
          toast.success('Assignment updated', {
            description: 'Order HM-2048 is now assigned to Sana.',
            action: { label: 'Undo', onClick: () => {} },
          })
        }
      >
        Show success toast
      </Button>
      <ProgressStatus
        label="Importing conversations"
        value={156}
        max={240}
        detail="Importing 156 of 240"
        action={
          <Button variant="secondary" size="sm">
            Pause
          </Button>
        }
      />
    </div>
  ),
};
