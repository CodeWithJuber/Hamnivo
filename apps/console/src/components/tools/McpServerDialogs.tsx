import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type McpServer, toolKeys } from '../../lib/actions';
import type { McpOAuthStart } from '../../lib/ai-power';
import { ApiError, api, isApiError } from '../../lib/api';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { AppDialog, ConfirmDialog, DialogFooter } from '../AppDialog';
import { CheckboxField, TextField } from '../Fields';
import { ActionError } from '../States';

const webAddress = (value: string) => {
  try {
    return ['https:', 'http:'].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
};

/**
 * Sends the browser to the service's sign-in page. Only a web address is followed, whatever the
 * service's documents said (the gateway checks it too).
 */
function goTo(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    window.location.assign(url.href);
    return true;
  } catch {
    return false;
  }
}

/** Starts a sign-in to a server, and sends the browser to the service. */
export async function startMcpSignIn(
  serverId: string,
  body: { clientId?: string; clientSecret?: string },
  tenant: string,
): Promise<McpOAuthStart> {
  const started = await api<McpOAuthStart>(`/v1/admin/mcp-servers/${serverId}/oauth/start`, {
    method: 'POST',
    body,
    tenant,
  });
  if (!goTo(started.authorizationUrl)) throw new Error('The sign-in address is not usable.');
  return started;
}

function useMcpSignIn(server: Pick<McpServer, 'id'>) {
  return useStudioMutation(
    (body: { clientId?: string; clientSecret?: string }, tenant) =>
      startMcpSignIn(server.id, body, tenant),
    [],
  );
}

/**
 * Signing in to an MCP server with OAuth (D10): the person goes to the service and comes back to
 * Studio. Most services register Hamnivo themselves; for one that does not, the client ID the
 * service gave is entered here.
 */
export function SignInDialog({
  server,
  open,
  onOpenChange,
}: {
  server: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [manual, setManual] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const signIn = useMcpSignIn(server);
  const redirect = `${window.location.origin}/connect/mcp`;
  // Said in the field, where the client ID goes, instead of as an error of the whole form.
  const needsClient =
    signIn.error instanceof ApiError && signIn.error.problem?.reason === 'client_required';

  useEffect(() => {
    if (!open) return;
    setManual(false);
    setClientId('');
    setClientSecret('');
    setErrors({});
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (manual && !clientId.trim()) next['signin-clientId'] = t('aiPower.mcp.signIn.needsClient');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await signIn.mutateAsync({
        ...(manual && clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(manual && clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      });
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED') && error.problem?.reason === 'client_required') {
        setManual(true);
        setErrors({ 'signin-clientId': t('aiPower.mcp.signIn.needsClient') });
      }
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!signIn.isPending) onOpenChange(next);
      }}
      title={t('aiPower.mcp.signIn.title', { name: server.label })}
      description={t('aiPower.mcp.signIn.description')}
      testId="sign-in-dialog"
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <CheckboxField
          id="signin-manual"
          label={t('aiPower.mcp.signIn.manual')}
          hint={t('aiPower.mcp.signIn.manualHint')}
          checked={manual}
          onCheckedChange={setManual}
        />
        {manual ? (
          <>
            <p className="text-sm text-text-secondary">
              {t('aiPower.mcp.signIn.redirect')}:{' '}
              <bdi dir="ltr" className="font-mono text-xs break-all">
                {redirect}
              </bdi>
            </p>
            <TextField
              id="signin-clientId"
              label={t('aiPower.mcp.signIn.clientId')}
              value={clientId}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              maxLength={300}
              onChange={(event) => setClientId(event.target.value)}
              error={errors['signin-clientId']}
            />
            <TextField
              id="signin-clientSecret"
              label={t('aiPower.mcp.signIn.clientSecret')}
              labelNote={t('tools.optional')}
              hint={t('aiPower.mcp.signIn.clientSecretHint')}
              value={clientSecret}
              dir="ltr"
              type="password"
              autoComplete="off"
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </>
        ) : errors['signin-clientId'] ? (
          <p role="alert" className="text-sm text-danger">
            {errors['signin-clientId']}
          </p>
        ) : null}
        <ActionError error={isCancelled(signIn.error) || needsClient ? null : signIn.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={signIn.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={signIn.isPending} data-testid="sign-in-continue">
            {signIn.isPending ? t('aiPower.mcp.signIn.leaving') : t('aiPower.mcp.signIn.continue')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Edits a server's name and address, and replaces or removes its token. */
export function EditServerDialog({
  server,
  open,
  onOpenChange,
}: {
  server: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [label, setLabel] = useState(server.label);
  const [url, setUrl] = useState(server.url);
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setLabel(server.label);
    setUrl(server.url);
    setToken('');
    setRemoveToken(false);
    setErrors({});
  }, [open, server.label, server.url]);

  const save = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      api<McpServer>(`/v1/admin/mcp-servers/${server.id}`, { method: 'PATCH', body, tenant }),
    [toolKeys.servers, toolKeys.tools],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!label.trim()) next['edit-label'] = t('tools.errors.label');
    if (!webAddress(url)) next['edit-url'] = t('tools.errors.url');
    if (token.trim() && token.trim().length < 8) next['edit-token'] = t('tools.errors.token');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: Record<string, unknown> = {};
    if (label.trim() !== server.label) body.label = label.trim();
    if (url.trim() !== server.url) body.url = url.trim();
    if (token.trim()) body.token = token.trim();
    else if (removeToken) body.token = null;
    if (Object.keys(body).length === 0) {
      announce(t('aiPower.mcp.edit.nothing'));
      onOpenChange(false);
      return;
    }
    try {
      const updated = await save.mutateAsync(body);
      announce(t('aiPower.mcp.edit.saved', { name: updated.label }));
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) fields[`edit-${field.path}`] = field.message;
        setErrors(fields);
      }
    }
  };

  const addressChanged = url.trim() !== server.url;
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
      title={t('aiPower.mcp.edit.title', { name: server.label })}
      description={t('aiPower.mcp.edit.description')}
      testId="edit-server-dialog"
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          id="edit-label"
          label={t('aiPower.mcp.edit.label')}
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          error={errors['edit-label']}
        />
        <TextField
          id="edit-url"
          label={t('aiPower.mcp.edit.url')}
          hint={addressChanged ? t('aiPower.mcp.edit.urlWarning') : undefined}
          value={url}
          dir="ltr"
          type="url"
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
          error={errors['edit-url']}
        />
        <TextField
          id="edit-token"
          label={t('aiPower.mcp.edit.token')}
          labelNote={t('tools.optional')}
          hint={t('aiPower.mcp.edit.tokenHint')}
          value={token}
          dir="ltr"
          type="password"
          autoComplete="off"
          onChange={(event) => setToken(event.target.value)}
          error={errors['edit-token']}
        />
        {server.auth.kind === 'token' ? (
          <CheckboxField
            id="edit-remove-token"
            label={t('aiPower.mcp.edit.removeToken')}
            checked={removeToken && !token.trim()}
            onCheckedChange={setRemoveToken}
            disabled={Boolean(token.trim())}
          />
        ) : null}
        {server.auth.kind === 'oauth' ? (
          <p className="text-sm text-text-secondary">{t('aiPower.mcp.edit.removeSignIn')}</p>
        ) : null}
        <ActionError
          error={
            isCancelled(save.error) || isApiError(save.error, 'VALIDATION_FAILED')
              ? null
              : save.error
          }
        />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending} data-testid="save-server">
            {t('aiPower.mcp.edit.save')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Asks before a server is removed: its tools go, its credentials are deleted. */
export function RemoveServerDialog({
  server,
  open,
  onOpenChange,
}: {
  server: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const remove = useStudioMutation(
    (_: undefined, tenant) =>
      api<undefined>(`/v1/admin/mcp-servers/${server.id}`, { method: 'DELETE', tenant }),
    [toolKeys.servers, toolKeys.tools],
  );
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('aiPower.mcp.remove.title', { name: server.label })}
      confirmLabel={t('aiPower.mcp.remove.confirm')}
      variant="destructive-solid"
      testId="remove-server-dialog"
      onConfirm={async () => {
        await remove.mutateAsync(undefined);
        announce(t('aiPower.mcp.remove.done', { name: server.label }));
      }}
    >
      <p>{t('aiPower.mcp.remove.body')}</p>
    </ConfirmDialog>
  );
}

/** Asks before signing out of a server: the service forgets the access, the tools stop running. */
export function SignOutDialog({
  server,
  open,
  onOpenChange,
}: {
  server: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const signOut = useStudioMutation(
    (_: undefined, tenant) =>
      api<McpServer>(`/v1/admin/mcp-servers/${server.id}/oauth/disconnect`, {
        method: 'POST',
        tenant,
      }),
    [toolKeys.servers],
  );
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('aiPower.mcp.signOut.title', { name: server.label })}
      confirmLabel={t('aiPower.mcp.signOut.confirm')}
      variant="destructive-solid"
      testId="sign-out-dialog"
      onConfirm={async () => {
        await signOut.mutateAsync(undefined);
        announce(t('aiPower.mcp.signIn.signedOut', { name: server.label }));
      }}
    >
      <p>{t('aiPower.mcp.signOut.body')}</p>
    </ConfirmDialog>
  );
}
