import { BotIcon, GlobeIcon, LockIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../lib/utils';

export type Lane = 'public' | 'internal' | 'agent_work';

export const defaultLaneLabels: Record<Lane, { title: string; description: string }> = {
  public: { title: 'Reply', description: 'Visible to the customer' },
  internal: { title: 'Internal note', description: 'Visible to authorized teammates only' },
  agent_work: {
    title: 'Agent work',
    description: 'Specialist findings and tool activity for staff',
  },
};

const laneStyles: Record<Lane, string> = {
  public: 'border-border bg-surface',
  internal: 'border-dashed border-lane-internal-border bg-lane-internal',
  agent_work: 'border-lane-agent-work-border bg-lane-agent-work border-s-4',
};

const laneIcons: Record<Lane, typeof GlobeIcon> = {
  public: GlobeIcon,
  internal: LockIcon,
  agent_work: BotIcon,
};

type LaneLabelProps = React.ComponentProps<'span'> & {
  lane: Lane;
  labels?: Partial<Record<Lane, { title: string; description: string }>>;
  /** Show the description after the title ("Internal note · visible to authorized teammates only"). */
  withDescription?: boolean;
};

/** Text + icon lane label: private lanes are never distinguished by colour alone (H03, R04). */
function LaneLabel({ lane, labels, withDescription = false, className, ...props }: LaneLabelProps) {
  const text = { ...defaultLaneLabels[lane], ...labels?.[lane] };
  const Icon = laneIcons[lane];
  return (
    <span
      data-slot="lane-label"
      data-lane={lane}
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium text-text', className)}
      {...props}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{text.title}</span>
      {withDescription ? (
        <span className="font-normal text-text-secondary">· {text.description}</span>
      ) : null}
    </span>
  );
}

type LaneSurfaceProps = React.ComponentProps<'div'> & { lane: Lane };

/** Container styling for messages or composers in a given lane. */
function LaneSurface({ lane, className, ...props }: LaneSurfaceProps) {
  return (
    <div
      data-slot="lane-surface"
      data-lane={lane}
      className={cn('rounded-lg border', laneStyles[lane], className)}
      {...props}
    />
  );
}

export { LaneLabel, LaneSurface };
