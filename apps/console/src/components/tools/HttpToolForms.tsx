import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { HttpToolMethod } from '../../lib/ai-power';
import { ApiError } from '../../lib/api';
import { ChoiceField, TextField } from '../Fields';

/** Text of unknown direction inside a sentence keeps its own direction (U+2068 … U+2069). */
export const isolate = (text: string) => `\u2068${text}\u2069`;

/** What a person typed for the credential of a service. */
export interface AuthDraft {
  kind: 'none' | 'bearer' | 'header';
  token: string;
  header: string;
  value: string;
}

export const emptyAuth = (): AuthDraft => ({
  kind: 'none',
  token: '',
  header: 'X-Api-Key',
  value: '',
});

/** The credential as the gateway takes it. */
export type AuthBody =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'header'; header: string; value: string };

export function authBody(auth: AuthDraft): AuthBody {
  if (auth.kind === 'bearer') return { kind: 'bearer', token: auth.token.trim() };
  if (auth.kind === 'header') {
    return { kind: 'header', header: auth.header.trim(), value: auth.value.trim() };
  }
  return { kind: 'none' };
}

const WEB_ADDRESS = /^https?:\/\/\S+$/i;
const HEADER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Problems a person can fix without asking the gateway, by field id. */
export function authErrors(auth: AuthDraft, id: string, t: TFunction): Record<string, string> {
  const errors: Record<string, string> = {};
  if (auth.kind === 'bearer' && auth.token.trim().length < 8) {
    errors[`${id}-token`] = t('aiPower.http.service.errors.token');
  }
  if (auth.kind === 'header') {
    if (!HEADER_NAME.test(auth.header.trim())) {
      errors[`${id}-header`] = t('aiPower.http.service.errors.headerName');
    }
    if (!auth.value.trim()) errors[`${id}-value`] = t('aiPower.http.service.errors.value');
  }
  return errors;
}

export function addressError(url: string, id: string, t: TFunction): Record<string, string> {
  return WEB_ADDRESS.test(url.trim())
    ? {}
    : { [`${id}-baseUrl`]: t('aiPower.http.service.errors.baseUrl') };
}

/**
 * What the gateway refused, by field: `endpoint.path` is the `path` of a request, a problem with
 * any argument is one for `arguments`, and with the credential one for `auth`. The first message
 * of each is kept.
 */
export function refusedPaths(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return {};
  const out: Record<string, string> = {};
  for (const field of error.fields) {
    const path = field.path.replace(/^endpoint\./, '');
    const key = path.startsWith('arguments')
      ? 'arguments'
      : path.startsWith('auth')
        ? 'auth'
        : path;
    out[key] ??= field.message;
  }
  return out;
}

/** How the tools of a service sign in: nothing, a token, or a secret in a header. */
export function AuthFields({
  id,
  auth,
  onChange,
  errors,
  legend,
  kinds = ['none', 'bearer', 'header'],
}: {
  id: string;
  auth: AuthDraft;
  onChange: (next: AuthDraft) => void;
  errors: Record<string, string>;
  legend?: string;
  /** Which kinds of credential to offer. */
  kinds?: readonly AuthDraft['kind'][];
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <ChoiceField
        id={`${id}-kind`}
        legend={legend ?? t('aiPower.http.service.auth.legend')}
        value={auth.kind}
        onValueChange={(kind) => onChange({ ...auth, kind: kind as AuthDraft['kind'] })}
        choices={kinds.map((kind) => ({
          value: kind,
          label: t(`aiPower.http.service.auth.${kind}`),
          hint: t(`aiPower.http.service.auth.${kind}Hint`),
        }))}
      />
      {auth.kind === 'bearer' ? (
        <TextField
          id={`${id}-token`}
          label={t('aiPower.http.service.auth.token')}
          hint={t('aiPower.http.service.auth.tokenHint')}
          value={auth.token}
          dir="ltr"
          type="password"
          autoComplete="off"
          onChange={(event) => onChange({ ...auth, token: event.target.value })}
          error={errors[`${id}-token`] ?? errors[`${id}-auth`]}
        />
      ) : null}
      {auth.kind === 'header' ? (
        <>
          <TextField
            id={`${id}-header`}
            label={t('aiPower.http.service.auth.headerName')}
            hint={t('aiPower.http.service.auth.headerNameHint')}
            value={auth.header}
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onChange({ ...auth, header: event.target.value })}
            error={errors[`${id}-header`]}
          />
          <TextField
            id={`${id}-value`}
            label={t('aiPower.http.service.auth.value')}
            hint={t('aiPower.http.service.auth.valueHint')}
            value={auth.value}
            dir="ltr"
            type="password"
            autoComplete="off"
            onChange={(event) => onChange({ ...auth, value: event.target.value })}
            error={errors[`${id}-value`] ?? errors[`${id}-auth`]}
          />
        </>
      ) : null}
    </div>
  );
}

/** The name, the address and the credential of a service. */
export function ServiceFields({
  id,
  name,
  baseUrl,
  auth,
  onName,
  onBaseUrl,
  onAuth,
  errors,
}: {
  id: string;
  name: string;
  baseUrl: string;
  auth: AuthDraft;
  onName: (value: string) => void;
  onBaseUrl: (value: string) => void;
  onAuth: (next: AuthDraft) => void;
  errors: Record<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <TextField
        id={`${id}-name`}
        label={t('aiPower.http.service.name')}
        hint={t('aiPower.http.service.nameHint')}
        value={name}
        maxLength={80}
        onChange={(event) => onName(event.target.value)}
        error={errors[`${id}-name`]}
      />
      <TextField
        id={`${id}-baseUrl`}
        label={t('aiPower.http.service.baseUrl')}
        hint={t('aiPower.http.service.baseUrlHint')}
        value={baseUrl}
        dir="ltr"
        type="url"
        spellCheck={false}
        autoComplete="off"
        placeholder="https://api.example.com/v1"
        onChange={(event) => onBaseUrl(event.target.value)}
        error={errors[`${id}-baseUrl`]}
      />
      <AuthFields id={`${id}-auth`} auth={auth} onChange={onAuth} errors={errors} />
    </div>
  );
}

const METHOD_TONES: Record<HttpToolMethod, 'info' | 'success' | 'warning' | 'danger'> = {
  GET: 'info',
  POST: 'success',
  PUT: 'warning',
  PATCH: 'warning',
  DELETE: 'danger',
};

/** The method of a request, with the path it goes to. The text is the signal; the tone only helps. */
export function RequestLine({ method, path }: { method: HttpToolMethod; path: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusBadge tone={METHOD_TONES[method]} icon={null} className="font-mono" dir="ltr">
        {method}
      </StatusBadge>
      <bdi dir="ltr" className="min-w-0 break-all font-mono text-xs text-text">
        {path}
      </bdi>
    </span>
  );
}
