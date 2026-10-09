import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BLOCK_DURATIONS,
  type BlockDuration,
  type BlockTarget,
  expiryFor,
  fieldError,
  REASON_MAX,
  useBlockVisitor,
} from '../lib/blocks';
import { formatDateTime } from '../lib/format';
import { AppDialog, DialogFooter } from './AppDialog';
import { CheckboxField, ChoiceField, TextareaField } from './Fields';
import { ActionError } from './States';

/**
 * Blocks a visitor who misuses the chat (H20): why (for the team only), for how long and, from a
 * chat, whether to close it too. The visitor is told only that chat isn't available. The
 * gateway's field messages show on their field; success is announced, and focus goes back to
 * the control that opened the dialog.
 */
export function BlockVisitorDialog({
  target,
  onClose,
  fallbackFocus,
}: {
  /** Who to block; null while the dialog is closed. */
  target: BlockTarget | null;
  onClose: () => void;
  /** Where focus goes when the control that opened the dialog is gone (a menu item). */
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const block = useBlockVisitor();
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<BlockDuration>('day');
  const [closeChat, setCloseChat] = useState(true);
  const [missing, setMissing] = useState(false);
  const fromChat = target?.kind === 'conversation';

  // Each visitor starts from an empty form.
  const key = target ? `${target.kind}:${target.name}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when another visitor is chosen
  useEffect(() => {
    if (!key) return;
    setReason('');
    setDuration('day');
    setCloseChat(true);
    setMissing(false);
    block.reset();
  }, [key]);

  const close = () => {
    if (!block.isPending) onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    const text = reason.trim();
    if (!text) {
      setMissing(true);
      requestAnimationFrame(() => document.getElementById('block-reason')?.focus());
      return;
    }
    setMissing(false);
    const closing = fromChat && closeChat;
    block.mutate(
      { target, reason: text, duration, closeChat: closing },
      {
        onSuccess: () => {
          void block.refresh(target);
          announce(
            t(closing ? 'inbox.blocking.dialog.doneClosed' : 'inbox.blocking.dialog.done', {
              name: target.name,
            }),
          );
          onClose();
        },
      },
    );
  };

  const reasonError = missing
    ? t('inbox.blocking.dialog.reasonMissing')
    : fieldError(block.error, 'reason');
  const durationError = fieldError(block.error, 'duration');
  const fieldsSaid = Boolean(reasonError || durationError) && !missing;
  const now = new Date();

  return (
    <AppDialog
      open={target !== null}
      onOpenChange={(open) => !open && close()}
      title={t('inbox.blocking.dialog.title', { name: target?.name ?? '' })}
      description={t('inbox.blocking.dialog.explanation')}
      testId="block-dialog"
      {...(fallbackFocus ? { fallbackFocus } : {})}
    >
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <TextareaField
          id="block-reason"
          label={t('inbox.blocking.dialog.reason')}
          hint={t('inbox.blocking.dialog.reasonHint')}
          error={reasonError}
          value={reason}
          maxLength={REASON_MAX}
          rows={3}
          required
          aria-required="true"
          onChange={(event) => {
            setReason(event.target.value);
            if (missing && event.target.value.trim()) setMissing(false);
          }}
        />
        <ChoiceField
          id="block-duration"
          legend={t('inbox.blocking.dialog.duration')}
          value={duration}
          error={durationError}
          onValueChange={(value) => setDuration(BLOCK_DURATIONS.find((d) => d === value) ?? 'day')}
          choices={BLOCK_DURATIONS.map((value) => {
            const until = expiryFor(value, now);
            return {
              value,
              label: t(`inbox.blocking.durations.${value}`),
              hint: until
                ? t('inbox.blocking.durationHints.until', {
                    time: formatDateTime(until.toISOString()),
                  })
                : t('inbox.blocking.durationHints.never'),
            };
          })}
        />
        {fromChat ? (
          <CheckboxField
            id="block-close-chat"
            label={t('inbox.blocking.dialog.closeChat')}
            checked={closeChat}
            onCheckedChange={setCloseChat}
          />
        ) : null}
        {/* Field messages are on their fields; anything else is said here. */}
        {fieldsSaid ? null : <ActionError error={block.error} />}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={close} disabled={block.isPending}>
            {t('app.cancel')}
          </Button>
          <Button
            type="submit"
            variant="destructive-solid"
            busy={block.isPending}
            data-testid="block-submit"
          >
            {t('inbox.blocking.dialog.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
