import type { Meta, StoryObj } from '@storybook/react-vite';
import { SendIcon, Trash2Icon, ZapIcon } from 'lucide-react';
import { Button } from '../components/button';
import { ReasonedAction } from '../components/reasoned-action';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/tooltip';

/** HNV-24-01 Components — hover, focus-visible and pressed; HNV-24-02 disabled with a reason. */
const meta = {
  title: 'Interaction states/Controls (HNV-24-01, HNV-24-02)',
  parameters: {
    docs: { description: { component: 'Buttons follow the 15-state interaction contract.' } },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      <Button>
        <SendIcon aria-hidden="true" />
        Send
      </Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="destructive">
        <Trash2Icon aria-hidden="true" />
        Delete
      </Button>
      <ReasonedAction reason="Choose a handoff queue first">
        <Button>Publish</Button>
      </ReasonedAction>
      <Button busy>Saving</Button>
      <Button variant="link">View unassigned</Button>
    </div>
  ),
};

export const TooltipOnFocus: Story = {
  name: 'Tooltip also shows on keyboard focus',
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Use AI to draft a reply">
          <ZapIcon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Draft a customer reply using AI.</TooltipContent>
    </Tooltip>
  ),
};
