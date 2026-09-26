import type { Meta, StoryObj } from '@storybook/react-vite';
import { Ltr } from '../components/bidi';
import { LaneLabel, LaneSurface } from '../components/lane';
import { ParticipantBadge } from '../components/participant-badge';
import { ActionOutcomeBadge, DeliveryStatus, StatusBadge } from '../components/status-badge';

/** Identity, lanes and status atoms used across boards 05, 06, 09, 10 and 13. */
const meta = { title: 'Conversation atoms/Identity, lanes and status' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Participants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      <ParticipantBadge kind="customer" name="Maya Saleh" roleLabel="Customer" />
      <ParticipantBadge kind="human_agent" name="Sana Qureshi" roleLabel="Support agent" />
      <ParticipantBadge kind="ai_primary" name="Hamnivo AI" roleLabel="AI assistant" />
      <ParticipantBadge kind="ai_specialist" name="Billing specialist" roleLabel="AI specialist" />
      <ParticipantBadge kind="system" name="System" roleLabel="Notice" />
    </div>
  ),
};

export const Lanes: Story = {
  render: () => (
    <div className="grid max-w-xl gap-3">
      {(['public', 'internal', 'agent_work'] as const).map((lane) => (
        <LaneSurface key={lane} lane={lane} className="p-3">
          <LaneLabel lane={lane} withDescription />
          <p dir="auto" className="mt-1 text-sm">
            Order <Ltr mono>HM-2048</Ltr> is awaiting dispatch.
          </p>
        </LaneSurface>
      ))}
    </div>
  ),
};

export const Statuses: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <StatusBadge tone="warning">Human requested</StatusBadge>
        <StatusBadge tone="info">Waiting for a person</StatusBadge>
        <StatusBadge tone="success">Resolved</StatusBadge>
        <StatusBadge tone="danger">SLA breached</StatusBadge>
      </div>
      <div className="flex flex-wrap gap-4">
        <DeliveryStatus state="queued" label="Queued" />
        <DeliveryStatus state="accepted" label="Sent" />
        <DeliveryStatus state="delivered" label="Delivered" />
        <DeliveryStatus state="read" label="Read" />
        <DeliveryStatus state="failed" label="Not sent" />
      </div>
      <div className="flex flex-wrap gap-2">
        <ActionOutcomeBadge outcome="awaiting_approval" label="Waiting for approval" />
        <ActionOutcomeBadge outcome="executing" label="Checking order" />
        <ActionOutcomeBadge outcome="completed" label="Refund confirmed" />
        <ActionOutcomeBadge outcome="unknown" label="Outcome unconfirmed" />
      </div>
    </div>
  ),
};
