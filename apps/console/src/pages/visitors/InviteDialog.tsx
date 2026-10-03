import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { TextareaField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { isApiError } from '../../lib/api';
import { type LiveVisitor, useInviteVisitor } from '../../lib/visitors';

/** The longest invitation the gateway accepts. */
const MAX = 300;

/**
 * Asks what to say to a visitor and sends it as an invitation: the loader shows it next to the
 * chat button, the way it shows the brand's own proactive prompts, within a few seconds.
 */
export function InviteDialog({
  visitor,
  onClose,
}: {
  visitor: LiveVisitor | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const invite = useInviteVisitor();
  const [message, setMessage] = useState('');
  // Each visitor starts from the suggested words again.
  const id = visitor?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when another visitor is chosen
  useEffect(() => {
    setMessage(t('inboxAlerts.live.dialog.default'));
    invite.reset();
  }, [id]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!visitor || !message.trim()) return;
    invite.mutate(
      { visitorId: visitor.id, message: message.trim() },
      {
        onSuccess: () => {
          announce(t('inboxAlerts.live.dialog.sent'));
          onClose();
        },
      },
    );
  };

  return (
    <AppDialog
      open={visitor !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('inboxAlerts.live.dialog.title', { name: visitor?.name ?? '' })}
      description={t('inboxAlerts.live.dialog.description')}
      testId="invite-dialog"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextareaField
          id="invite-message"
          label={t('inboxAlerts.live.dialog.message')}
          hint={t('inboxAlerts.live.dialog.hint')}
          value={message}
          maxLength={MAX}
          rows={3}
          onChange={(event) => setMessage(event.target.value)}
        />
        {invite.error && isApiError(invite.error, 'NOT_FOUND') ? (
          <p role="alert" className="text-sm text-danger">
            {t('inboxAlerts.live.dialog.gone')}
          </p>
        ) : (
          <ActionError error={invite.error} />
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={invite.isPending} disabled={!message.trim()}>
            {t('inboxAlerts.live.dialog.send')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
