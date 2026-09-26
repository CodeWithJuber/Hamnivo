import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
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
} from '../src/components/alert-dialog';
import { Button } from '../src/components/button';
import { UnsavedChangesDialog } from '../src/components/unsaved-changes-dialog';

describe('Dialog and menu (HNV-24-04)', () => {
  it('moves focus into the dialog, traps Tab, closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button>Close conversation</Button>
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
      </AlertDialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Close conversation' });
    await user.click(trigger);
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsent reply?' });
    expect(dialog).toHaveAccessibleDescription('Your draft will be permanently lost.');
    // Safe default: the non-destructive choice receives focus first.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveFocus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe('UnsavedChangesDialog (HNV-24-05)', () => {
  function Harness({ onSave, onDiscard }: { onSave: () => Promise<void>; onDiscard: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <UnsavedChangesDialog
        open={open}
        title="Save changes?"
        description="You have unsaved changes."
        saveLabel="Save draft"
        discardLabel="Discard"
        stayLabel="Stay"
        onSave={async () => {
          await onSave();
          setOpen(false);
        }}
        onDiscard={() => {
          onDiscard();
          setOpen(false);
        }}
        onStay={() => setOpen(false)}
      />
    );
  }

  it('offers Save, Discard and Stay, and Stay keeps the work', async () => {
    const onSave = vi.fn(async () => {});
    const onDiscard = vi.fn();
    render(<Harness onSave={onSave} onDiscard={onDiscard} />);
    for (const name of ['Save draft', 'Discard', 'Stay']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('saves exactly once even when Save is pressed repeatedly', async () => {
    let resolve!: () => void;
    const onSave = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<Harness onSave={onSave} onDiscard={vi.fn()} />);
    const save = screen.getByRole('button', { name: 'Save draft' });
    await userEvent.click(save);
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});
