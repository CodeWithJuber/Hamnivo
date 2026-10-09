/**
 * Channels (Settings, ADR 0013): the email, WhatsApp and Telegram inboxes of a brand's Chatwoot
 * account, and the requests that list them, look for new ones and change one. A change shows at
 * once (the card is patched in the cache) and is put back if the gateway refuses it; the list is
 * read again afterwards, so a change saved here but not in Chatwoot still shows as saved.
 */
import type * as C from '@hamnivo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useStudioQuery } from './queries';
import { withReauth } from './reauth';
import { useTenant } from './tenant';
import type { Items, Team } from './types';

export type ChannelInbox = C.ChannelInbox;
export type ChannelKind = C.ChannelKind;
export type ChannelStatus = ChannelInbox['status'];
export type ChannelChange = C.UpdateChannelRequest;

export const CHANNEL_KINDS: readonly ChannelKind[] = ['email', 'whatsapp', 'telegram', 'other'];

export const channelKeys = {
  list: (brandId: string) => ['channels', brandId],
  email: (channelId: string) => ['channels', 'email', channelId],
} as const;

const listPath = (brandId: string) => `/v1/admin/brands/${encodeURIComponent(brandId)}/channels`;

export function useChannels(brandId: string) {
  const { can } = useTenant();
  return useStudioQuery<Items<ChannelInbox>>(channelKeys.list(brandId), listPath(brandId), {
    enabled: can('integrations.manage'),
  });
}

/** Channels of the brand first, then the ones its Chatwoot account has that answer for no brand. */
export function orderChannels(items: readonly ChannelInbox[]): ChannelInbox[] {
  return [...items.filter((c) => c.brandId !== null), ...items.filter((c) => c.brandId === null)];
}

/** How many channels a check found that the list did not have before. */
export function newChannelCount(
  before: readonly ChannelInbox[] | undefined,
  after: readonly ChannelInbox[],
): number {
  const known = new Set((before ?? []).map((channel) => channel.id));
  return after.filter((channel) => !known.has(channel.id)).length;
}

/** The channel as it will be once the change is saved (what the card shows while it saves). */
export function applyChange(
  channel: ChannelInbox,
  change: ChannelChange,
  now = new Date().toISOString(),
): ChannelInbox {
  const next = { ...channel };
  if (change.brandId !== undefined) next.brandId = change.brandId;
  if (change.aiAnswers !== undefined) next.aiAnswers = change.aiAnswers;
  if (change.defaultTeamId !== undefined) next.defaultTeamId = change.defaultTeamId;
  if (change.paused === true) {
    next.status = 'paused';
    next.pausedAt = channel.pausedAt ?? (now as ChannelInbox['pausedAt']);
  } else if (change.paused === false) {
    next.pausedAt = null;
    next.status = channel.problem ? 'needs_attention' : 'connected';
  }
  return next;
}

const replace = (
  list: Items<ChannelInbox> | undefined,
  id: string,
  update: (channel: ChannelInbox) => ChannelInbox,
): Items<ChannelInbox> | undefined =>
  list
    ? { items: list.items.map((channel) => (channel.id === id ? update(channel) : channel)) }
    : list;

/** "Check for new channels": the list as Chatwoot has it now, and how many of them are new. */
export function useFindChannels(brandId: string) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...channelKeys.list(brandId)];
  return useMutation({
    mutationFn: async () => {
      const before = client.getQueryData<Items<ChannelInbox>>(key);
      const found = await withReauth(() =>
        api<Items<ChannelInbox>>(`${listPath(brandId)}/find`, { method: 'POST', tenant: tenantId }),
      );
      return { found, added: newChannelCount(before?.items, found.items) };
    },
    onSuccess: ({ found }) => client.setQueryData(key, found),
  });
}

/** Changes one channel: the card shows the change at once and goes back if it is refused. */
export function useUpdateChannel(brandId: string, channelId: string) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...channelKeys.list(brandId)];
  return useMutation({
    mutationFn: (change: ChannelChange) =>
      withReauth(() =>
        api<ChannelInbox>(`/v1/admin/channels/${encodeURIComponent(channelId)}`, {
          method: 'PUT',
          body: change,
          tenant: tenantId,
        }),
      ),
    onMutate: async (change) => {
      await client.cancelQueries({ queryKey: key });
      const before = client
        .getQueryData<Items<ChannelInbox>>(key)
        ?.items.find((channel) => channel.id === channelId);
      client.setQueryData<Items<ChannelInbox>>(key, (list) =>
        replace(list, channelId, (channel) => applyChange(channel, change)),
      );
      return { before };
    },
    onError: (_error, _change, context) => {
      const before = context?.before;
      if (before) {
        client.setQueryData<Items<ChannelInbox>>(key, (list) =>
          replace(list, channelId, () => before),
        );
      }
    },
    onSuccess: (saved) => {
      client.setQueryData<Items<ChannelInbox>>(key, (list) =>
        replace(list, channelId, () => saved),
      );
    },
    // Read again either way: a change can be saved here while Chatwoot did not take it yet.
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

/** Teams that can take a brand's conversations: those of its workspace and the shared ones. */
export function teamsForBrand(
  teams: readonly Team[] | undefined,
  workspaceId: string | undefined,
): Team[] {
  return (teams ?? [])
    .filter((team) => team.status === 'active')
    .filter((team) => !workspaceId || team.workspaceId === null || team.workspaceId === workspaceId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ email (D13)

export type EmailProvider = C.EmailProvider;
export type EmailSettings = C.EmailChannelSettings;
export type ConnectEmailBody = C.ConnectEmailRequest;
export type UpdateEmailBody = C.UpdateEmailRequest;
export type SmtpSecurity = EmailSettings['smtp']['security'];

/**
 * Common providers' mail servers for "Find my settings": the contract's EMAIL_PROVIDERS, kept here
 * as data so the Channels page does not load every contract schema (a test checks they match).
 */
export const EMAIL_PROVIDERS: readonly EmailProvider[] = [
  {
    id: 'gmail',
    name: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { address: 'imap.gmail.com', port: 993, ssl: true },
    smtp: { address: 'smtp.gmail.com', port: 587, security: 'starttls' },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    passwordsWork: true,
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: { address: 'imap.zoho.com', port: 993, ssl: true },
    smtp: { address: 'smtp.zoho.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://accounts.zoho.com/home#security/app_password',
    passwordsWork: true,
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com'],
    imap: { address: 'imap.mail.yahoo.com', port: 993, ssl: true },
    smtp: { address: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://login.yahoo.com/account/security/app-passwords',
    passwordsWork: true,
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imap: { address: 'imap.fastmail.com', port: 993, ssl: true },
    smtp: { address: 'smtp.fastmail.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apps',
    passwordsWork: true,
  },
  {
    id: 'microsoft',
    name: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: null,
    smtp: null,
    appPasswordUrl: null,
    passwordsWork: false,
  },
  {
    id: 'custom',
    name: 'Another provider',
    domains: [],
    imap: null,
    smtp: null,
    appPasswordUrl: null,
    passwordsWork: true,
  },
];
export const SMTP_SECURITY: readonly SmtpSecurity[] = ['starttls', 'tls', 'none'];

const CUSTOM = EMAIL_PROVIDERS.find((provider) => provider.id === 'custom') as EmailProvider;

export const emailProvider = (id: string): EmailProvider | undefined =>
  EMAIL_PROVIDERS.find((provider) => provider.id === id);

/** The provider an address's domain suggests ("Find my settings"): a known one, else `custom`. */
export function providerForAddress(address: string): EmailProvider {
  const domain = address.trim().toLowerCase().split('@')[1] ?? '';
  return EMAIL_PROVIDERS.find((provider) => provider.domains.includes(domain)) ?? CUSTOM;
}

/**
 * A mailbox as the Connect and Email settings forms hold it while someone types. Ports are text
 * until sent. Passwords live here only while the dialog is open: never stored, never shown back.
 */
export interface EmailDraft {
  name: string;
  address: string;
  /** The chosen provider's id; empty until one is chosen or found. */
  provider: string;
  imap: { address: string; port: string; ssl: boolean; login: string; password: string };
  smtp: {
    address: string;
    port: string;
    security: SmtpSecurity;
    login: string;
    password: string;
  };
  /** Outgoing mail signs in with the incoming login and password. */
  sameLogin: boolean;
  aiAnswers: boolean;
  /** Empty: no team, routing decides. */
  defaultTeamId: string;
}

export function emptyEmailDraft(name: string): EmailDraft {
  return {
    name,
    address: '',
    provider: '',
    imap: { address: '', port: '993', ssl: true, login: '', password: '' },
    smtp: { address: '', port: '587', security: 'starttls', login: '', password: '' },
    sameLogin: true,
    aiAnswers: false,
    defaultTeamId: '',
  };
}

/** A mailbox's saved settings as a draft for Email settings (passwords empty: kept as they are). */
export function draftFromSettings(settings: EmailSettings): EmailDraft {
  return {
    name: settings.name,
    address: settings.address,
    provider: '',
    imap: { ...settings.imap, port: String(settings.imap.port), password: '' },
    smtp: { ...settings.smtp, port: String(settings.smtp.port), password: '' },
    sameLogin: false,
    aiAnswers: false,
    defaultTeamId: '',
  };
}

/** Fills in the provider's servers, ports and security; `custom` leaves them as they are. */
export function applyProvider(draft: EmailDraft, provider: EmailProvider): EmailDraft {
  return {
    ...draft,
    provider: provider.id,
    imap: provider.imap
      ? { ...draft.imap, ...provider.imap, port: String(provider.imap.port) }
      : draft.imap,
    smtp: provider.smtp
      ? { ...draft.smtp, ...provider.smtp, port: String(provider.smtp.port) }
      : draft.smtp,
  };
}

/** A new address; a login that was the old address (or empty) follows it. */
export function withAddress(draft: EmailDraft, address: string): EmailDraft {
  const follows = (login: string) => login === '' || login === draft.address;
  return {
    ...draft,
    address,
    imap: follows(draft.imap.login) ? { ...draft.imap, login: address } : draft.imap,
    smtp: follows(draft.smtp.login) ? { ...draft.smtp, login: address } : draft.smtp,
  };
}

/** Sets one field by its path (`address`, `imap.port`…), the way the gateway names fields. */
export function setEmailField(
  draft: EmailDraft,
  path: string,
  value: string | boolean,
): EmailDraft {
  if (path === 'address') return withAddress(draft, String(value));
  const [head, tail] = path.split('.') as [keyof EmailDraft, string | undefined];
  if (tail && (head === 'imap' || head === 'smtp')) {
    return { ...draft, [head]: { ...draft[head], [tail]: value } };
  }
  return { ...draft, [head]: value };
}

/** "993" → 993; anything that is not a whole number is NaN (and fails the check). */
const toPort = (port: string) => (/^\d+$/.test(port.trim()) ? Number(port.trim()) : Number.NaN);

/** Text the contract takes: trimmed, not empty, not longer than `max`. */
const text = (max: number) => (value: string) =>
  value.trim().length > 0 && value.trim().length <= max;
/** A plain address check, as strict as the contract's `z.email()` for what people type. */
const EMAIL =
  /^(?!\.)(?!.*\.\.)[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
const port = (value: string) => {
  const n = toPort(value);
  return Number.isInteger(n) && n >= 1 && n <= 65_535;
};
const password = (value: string) => value.length >= 1 && value.length <= 500;

/**
 * The contract's checks (ConnectEmailRequest, UpdateEmailRequest) for each field, by the path the
 * gateway uses for it, so Next can say what is missing before anything is sent.
 */
const CHECKS: Record<string, (draft: EmailDraft) => boolean> = {
  name: (d) => text(100)(d.name),
  address: (d) => d.address.trim().length <= 320 && EMAIL.test(d.address.trim()),
  'imap.address': (d) => text(255)(d.imap.address),
  'imap.port': (d) => port(d.imap.port),
  'imap.login': (d) => text(320)(d.imap.login),
  'imap.password': (d) => password(d.imap.password),
  'smtp.address': (d) => text(255)(d.smtp.address),
  'smtp.port': (d) => port(d.smtp.port),
  'smtp.login': (d) => text(320)(d.smtp.login),
  'smtp.password': (d) => password(d.smtp.password),
};

/** The fields among `paths` that would not pass the contract's checks, in the order given. */
export function invalidEmailFields(draft: EmailDraft, paths: readonly string[]): string[] {
  return paths.filter((path) => CHECKS[path] && !CHECKS[path](draft));
}

export type EmailStep = 1 | 2 | 3 | 4;
export const EMAIL_STEPS: readonly EmailStep[] = [1, 2, 3, 4];

/** The fields each step of Connect email asks for. */
export function emailStepFields(step: EmailStep, draft: EmailDraft): string[] {
  switch (step) {
    case 1:
      return ['address', 'name'];
    case 2:
      return ['imap.address', 'imap.port', 'imap.login', 'imap.password'];
    case 3:
      return draft.sameLogin
        ? ['smtp.address', 'smtp.port']
        : ['smtp.address', 'smtp.port', 'smtp.login', 'smtp.password'];
    default:
      return [];
  }
}

/** The step of Connect email that holds a field the gateway named; null for none of them. */
export function emailStepOf(path: string): EmailStep | null {
  if (path === 'name' || path === 'address') return 1;
  if (path.startsWith('imap.')) return 2;
  if (path.startsWith('smtp.')) return 3;
  if (path === 'aiAnswers' || path === 'defaultTeamId') return 4;
  return null;
}

/** What Connect sends: outgoing mail signs in like incoming mail when "same login" is ticked. */
export function connectEmailBody(draft: EmailDraft): ConnectEmailBody {
  const imapLogin = draft.imap.login.trim();
  return {
    name: draft.name.trim(),
    address: draft.address.trim(),
    imap: {
      address: draft.imap.address.trim(),
      port: toPort(draft.imap.port),
      ssl: draft.imap.ssl,
      login: imapLogin,
      password: draft.imap.password,
    },
    smtp: {
      address: draft.smtp.address.trim(),
      port: toPort(draft.smtp.port),
      security: draft.smtp.security,
      login: draft.sameLogin ? imapLogin : draft.smtp.login.trim(),
      password: draft.sameLogin ? draft.imap.password : draft.smtp.password,
    },
    aiAnswers: draft.aiAnswers,
    defaultTeamId: (draft.defaultTeamId || null) as ConnectEmailBody['defaultTeamId'],
  };
}

/** What Email settings saves: a password only for a section whose password is being changed. */
export function updateEmailBody(
  draft: EmailDraft,
  change: { imap: boolean; smtp: boolean },
): UpdateEmailBody {
  return {
    name: draft.name.trim(),
    address: draft.address.trim(),
    imap: {
      address: draft.imap.address.trim(),
      port: toPort(draft.imap.port),
      ssl: draft.imap.ssl,
      login: draft.imap.login.trim(),
      ...(change.imap ? { password: draft.imap.password } : {}),
    },
    smtp: {
      address: draft.smtp.address.trim(),
      port: toPort(draft.smtp.port),
      security: draft.smtp.security,
      login: draft.smtp.login.trim(),
      ...(change.smtp ? { password: draft.smtp.password } : {}),
    },
  };
}

const addToList = (list: Items<ChannelInbox> | undefined, channel: ChannelInbox) =>
  list && !list.items.some((one) => one.id === channel.id)
    ? { items: [...list.items, channel] }
    : list;

/** Connect email: Chatwoot signs in to the mailbox first; the new channel joins the list. */
export function useConnectEmail(brandId: string) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...channelKeys.list(brandId)];
  return useMutation({
    mutationFn: (body: ConnectEmailBody) =>
      withReauth(() =>
        api<ChannelInbox>(`${listPath(brandId)}/email`, {
          method: 'POST',
          body,
          tenant: tenantId,
        }),
      ),
    onSuccess: async (channel) => {
      client.setQueryData<Items<ChannelInbox>>(key, (list) => addToList(list, channel));
      await client.invalidateQueries({ queryKey: key });
    },
  });
}

const emailPath = (channelId: string) =>
  `/v1/admin/channels/${encodeURIComponent(channelId)}/email`;

/** A mailbox's settings as Chatwoot has them, without passwords. */
export function useEmailSettings(channelId: string) {
  const { can } = useTenant();
  return useStudioQuery<EmailSettings>(channelKeys.email(channelId), emailPath(channelId), {
    enabled: can('integrations.manage'),
  });
}

/** Saves Email settings; the card shows the channel as the gateway sends it back. */
export function useUpdateEmail(brandId: string, channelId: string) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...channelKeys.list(brandId)];
  return useMutation({
    mutationFn: (body: UpdateEmailBody) =>
      withReauth(() =>
        api<ChannelInbox>(emailPath(channelId), { method: 'PUT', body, tenant: tenantId }),
      ),
    onSuccess: (saved) => {
      client.setQueryData<Items<ChannelInbox>>(key, (list) =>
        replace(list, channelId, () => saved),
      );
      // Read the settings afresh next time; the list again, for what Chatwoot found.
      client.removeQueries({ queryKey: [tenantId, ...channelKeys.email(channelId)] });
      void client.invalidateQueries({ queryKey: key });
    },
  });
}
