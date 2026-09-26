import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/alert-dialog';
import { Button } from '../components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/dropdown-menu';
import { Label } from '../components/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../components/sheet';
import { Textarea } from '../components/textarea';

/** HNV-24-04 Dialog and menu — open, focus trapped, dismissed with focus returned to the trigger. */
const meta = { title: 'Interaction states/Dialog and menu (HNV-24-04)' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ConfirmDialog: Story = {
  render: () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="secondary">Close conversation</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsent reply?</AlertDialogTitle>
          <AlertDialogDescription>Your draft will be permanently lost.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction>Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
};

export const RightDrawer: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button>Hand off</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Handoff details</SheetTitle>
          <SheetDescription>
            The next owner receives this context with the conversation.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-2 px-4">
          <Label htmlFor="handoff-note">Add a note (optional)</Label>
          <Textarea id="handoff-note" placeholder="Share any helpful context…" />
        </div>
        <SheetFooter>
          <Button>Submit handoff</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
};

export const RoleMenu: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">Role: Agent</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Choose a role</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Owner — full access to the workspace</DropdownMenuItem>
        <DropdownMenuItem>Admin — manage team and settings</DropdownMenuItem>
        <DropdownMenuItem>Agent — respond to conversations</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
