import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ConnectionBanner } from '../components/async-states';
import { Button } from '../components/button';
import { UnsavedChangesDialog } from '../components/unsaved-changes-dialog';

/** HNV-24-05 Global error — recoverable, offline and unsaved navigation. */
const meta = { title: 'Interaction states/Global error (HNV-24-05)' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Offline: Story = {
  render: () => (
    <div className="grid max-w-xl gap-3">
      <ConnectionBanner
        state="reconnecting"
        message="Reconnecting…"
        lastSynced="Last synced 10:24"
      />
      <ConnectionBanner
        state="offline"
        message="You're offline. Your draft is saved on this device."
        retryLabel="Retry now"
        onRetry={() => {}}
      />
      <ConnectionBanner
        state="degraded"
        message="Reports are temporarily unavailable. The inbox is working."
      />
    </div>
  ),
};

export const UnsavedNavigation: Story = {
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Leave settings
        </Button>
        <UnsavedChangesDialog
          open={open}
          title="Save changes to widget settings?"
          description="You have unsaved changes. Leaving now will discard them."
          saveLabel="Save draft"
          discardLabel="Discard"
          stayLabel="Stay"
          onSave={() => setOpen(false)}
          onDiscard={() => setOpen(false)}
          onStay={() => setOpen(false)}
        />
      </>
    );
  },
};
