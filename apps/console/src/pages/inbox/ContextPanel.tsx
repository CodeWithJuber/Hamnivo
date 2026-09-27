import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { Link } from '@tanstack/react-router';
import { LinkIcon, StarIcon, XIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckboxField,
  ChoiceField,
  SelectField,
  TextareaField,
  TextField,
} from '../../components/Fields';
import { ActionError, ErrorPanel, ListSkeleton } from '../../components/States';
import { api, isApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import {
  type ConversationFields,
  type ConversationTags,
  type FieldDefinition,
  type FieldValue,
  type InboxDetail,
  type InboxSearch,
  useConversationChange,
  useCustomer,
  useFields,
  useLinks,
  useReviews,
  useTags,
} from '../../lib/inbox';
import { ConversationStatusBadge, IdentityBadge, languageName } from './parts';

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-b border-border p-4">
      <h3 id={id} className="text-sm font-semibold text-text">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Loading() {
  return <ListSkeleton rows={2} />;
}

function Customer({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const customer = useCustomer(detail.id);
  if (customer.error && !customer.data) {
    return (
      <ErrorPanel
        error={customer.error}
        onRetry={() => customer.refetch()}
        retrying={customer.isRefetching}
      />
    );
  }
  if (!customer.data) return <Loading />;
  const c = customer.data;
  const language = languageName(c.language);
  return (
    <div className="flex flex-col gap-3" data-testid="customer-context">
      <div className="flex flex-col gap-1">
        <p className="font-medium text-text">
          <bdi>{c.displayName}</bdi>
        </p>
        <div>
          <IdentityBadge identity={c.identity} />
        </div>
        <p className="text-xs text-text-secondary">
          {c.identity === 'verified'
            ? t('inbox.customer.verifiedHint')
            : t('inbox.customer.anonymousHint')}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {c.email ? (
          <>
            <dt className="text-text-secondary">{t('inbox.customer.email')}</dt>
            <dd className="min-w-0 break-all">
              <bdi dir="ltr">{c.email}</bdi>
            </dd>
          </>
        ) : null}
        {c.unverifiedEmail ? (
          <>
            <dt className="text-text-secondary">{t('inbox.customer.unverifiedEmail')}</dt>
            <dd className="min-w-0 break-all">
              <bdi dir="ltr">{c.unverifiedEmail}</bdi>{' '}
              <span className="text-xs text-warning">{t('inbox.customer.notVerified')}</span>
            </dd>
          </>
        ) : null}
        {c.externalId ? (
          <>
            <dt className="text-text-secondary">{t('inbox.customer.externalId')}</dt>
            <dd className="min-w-0 break-all font-mono text-xs">
              <bdi dir="ltr">{c.externalId}</bdi>
            </dd>
          </>
        ) : null}
        {language ? (
          <>
            <dt className="text-text-secondary">{t('inbox.customer.language')}</dt>
            <dd>
              <bdi>{language}</bdi>
            </dd>
          </>
        ) : null}
        {c.brand ? (
          <>
            <dt className="text-text-secondary">{t('inbox.customer.brand')}</dt>
            <dd>
              <bdi>{c.brand.name}</bdi>
            </dd>
          </>
        ) : null}
        {c.customerSince ? (
          <>
            <dt className="text-text-secondary">{t('inbox.customer.since')}</dt>
            <dd>{formatDateTime(c.customerSince)}</dd>
          </>
        ) : null}
        {c.lastSeenAt ? (
          <>
            <dt className="text-text-secondary">{t('inbox.customer.lastSeen')}</dt>
            <dd>{formatDateTime(c.lastSeenAt)}</dd>
          </>
        ) : null}
        {c.attributes.map((a) => (
          <div key={a.key} className="contents">
            <dt className="text-text-secondary">
              <bdi dir="ltr">{a.key}</bdi>
            </dt>
            <dd className="min-w-0 break-words">
              <bdi dir="auto">{a.value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold text-text-secondary">
          {t('inbox.customer.previous')}
        </h4>
        {c.previousConversations.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('inbox.customer.noPrevious')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {c.previousConversations.map((p) => (
              <li key={p.id}>
                <Link
                  to="/inbox/$conversationId"
                  params={{ conversationId: p.id }}
                  search={(prev: InboxSearch) => prev}
                  className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm hover:bg-surface-sunken"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <ConversationStatusBadge status={p.status} />
                    <time dateTime={p.lastActivityAt} className="text-xs text-text-secondary">
                      {formatDateTime(p.lastActivityAt)}
                    </time>
                  </span>
                  {p.preview ? (
                    <span className="line-clamp-2 text-text-secondary">
                      <bdi dir="auto">{p.preview}</bdi>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Tags({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const tags = useTags(detail.id);
  const [adding, setAdding] = useState('');
  const change = useConversationChange(
    detail.id,
    (labels: string[], tenantId) =>
      api<ConversationTags>(`/v1/inbox/conversations/${detail.id}/tags`, {
        method: 'PUT',
        tenant: tenantId,
        body: { labels },
      }),
    ['tags'],
  );
  if (tags.error && !tags.data) {
    return (
      <ErrorPanel error={tags.error} onRetry={() => tags.refetch()} retrying={tags.isRefetching} />
    );
  }
  if (!tags.data) return <Loading />;
  const current = tags.data.labels;
  const options = tags.data.options.filter((o) => !current.includes(o.title));
  const editable = detail.permissions.tag;
  const set = (labels: string[], message: string) =>
    change.mutate(labels, { onSuccess: () => announce(message) });
  return (
    <div className="flex flex-col gap-3" data-testid="tags">
      {current.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('inbox.tags.none')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {current.map((label) => (
            <li key={label}>
              <StatusBadge tone="neutral" icon={null} className="gap-1 pe-1">
                <bdi>{label}</bdi>
                {editable ? (
                  <button
                    type="button"
                    className="inline-flex size-5 items-center justify-center rounded-full hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label={t('inbox.tags.remove', { name: label })}
                    onClick={() =>
                      set(
                        current.filter((l) => l !== label),
                        t('inbox.tags.removed', { name: label }),
                      )
                    }
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </button>
                ) : null}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}
      {editable && options.length > 0 ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!adding) return;
            set([...current, adding], t('inbox.tags.added', { name: adding }));
            setAdding('');
          }}
        >
          <div className="min-w-0 flex-1">
            <SelectField
              id={`tag-add-${detail.id}`}
              label={t('inbox.tags.add')}
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
              placeholder={t('inbox.tags.choose')}
              options={options.map((o) => ({ value: o.title, label: o.title }))}
            />
          </div>
          <Button type="submit" variant="secondary" busy={change.isPending} disabled={!adding}>
            {t('inbox.tags.addButton')}
          </Button>
        </form>
      ) : null}
      {editable && tags.data.options.length === 0 ? (
        <p className="text-xs text-text-secondary">{t('inbox.tags.noneDefined')}</p>
      ) : null}
      <ActionError error={change.error} />
    </div>
  );
}

function fieldInput(
  definition: FieldDefinition,
  value: FieldValue | undefined,
  onChange: (value: FieldValue) => void,
  id: string,
  error: string | undefined,
  disabled: boolean,
) {
  const text = value === null || value === undefined ? '' : String(value);
  switch (definition.type) {
    case 'checkbox':
      return (
        <CheckboxField
          id={id}
          label={definition.name}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
          disabled={disabled}
        />
      );
    case 'list':
      return (
        <SelectField
          id={id}
          label={definition.name}
          value={text}
          onChange={(event) => onChange(event.target.value || null)}
          placeholder={'—'}
          options={definition.options.map((o) => ({ value: o, label: o }))}
          error={error}
          disabled={disabled}
        />
      );
    default:
      return (
        <TextField
          id={id}
          label={definition.name}
          value={text}
          type={definition.type === 'date' ? 'date' : definition.type === 'link' ? 'url' : 'text'}
          inputMode={
            definition.type === 'number' ||
            definition.type === 'currency' ||
            definition.type === 'percent'
              ? 'decimal'
              : undefined
          }
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          error={error}
          disabled={disabled}
          {...(definition.description ? { hint: definition.description } : {})}
        />
      );
  }
}

function Fields({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const fields = useFields(detail.id);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const change = useConversationChange(
    detail.id,
    (changes: Record<string, FieldValue>, tenantId) =>
      api<ConversationFields>(`/v1/inbox/conversations/${detail.id}/fields`, {
        method: 'PATCH',
        tenant: tenantId,
        body: { values: changes },
      }),
    ['fields'],
  );
  useEffect(() => {
    if (fields.data && dirty.size === 0) setValues(fields.data.values);
  }, [fields.data, dirty.size]);
  if (fields.error && !fields.data) {
    return (
      <ErrorPanel
        error={fields.error}
        onRetry={() => fields.refetch()}
        retrying={fields.isRefetching}
      />
    );
  }
  if (!fields.data) return <Loading />;
  if (fields.data.definitions.length === 0) {
    return <p className="text-sm text-text-secondary">{t('inbox.fields.none')}</p>;
  }
  const errors = new Map(
    isApiError(change.error, 'VALIDATION_FAILED')
      ? change.error.fields.map((f) => [f.path.replace(/^values\./, ''), f.message])
      : [],
  );
  const editable = detail.permissions.tag;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes = Object.fromEntries([...dirty].map((key) => [key, values[key] ?? null]));
    change.mutate(changes, {
      onSuccess: () => {
        setDirty(new Set());
        announce(t('inbox.fields.saved'));
      },
    });
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit} data-testid="fields">
      {fields.data.definitions.map((definition) => (
        <div key={definition.key}>
          {fieldInput(
            definition,
            values[definition.key],
            (value) => {
              setValues((prev) => ({ ...prev, [definition.key]: value }));
              setDirty((prev) => new Set(prev).add(definition.key));
            },
            `field-${detail.id}-${definition.key}`,
            errors.get(definition.key),
            !editable,
          )}
        </div>
      ))}
      {change.error && !isApiError(change.error, 'VALIDATION_FAILED') ? (
        <ActionError error={change.error} />
      ) : null}
      {editable ? (
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          busy={change.isPending}
          disabled={dirty.size === 0}
        >
          {t('inbox.fields.save')}
        </Button>
      ) : null}
    </form>
  );
}

function Links({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const links = useLinks(detail.id);
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const create = useConversationChange(
    detail.id,
    (body: { conversationId: string; note?: string }, tenantId) =>
      api(`/v1/inbox/conversations/${detail.id}/links`, { method: 'POST', tenant: tenantId, body }),
    ['links'],
  );
  const remove = useConversationChange(
    detail.id,
    (linkId: string, tenantId) =>
      api<void>(`/v1/inbox/conversations/${detail.id}/links/${linkId}`, {
        method: 'DELETE',
        tenant: tenantId,
      }),
    ['links'],
  );
  return (
    <div className="flex flex-col gap-3" data-testid="links">
      {links.error && !links.data ? (
        <ErrorPanel
          error={links.error}
          onRetry={() => links.refetch()}
          retrying={links.isRefetching}
        />
      ) : !links.data ? (
        <Loading />
      ) : links.data.items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('inbox.links.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {links.data.items.map((link) => (
            <li
              key={link.id}
              className="flex items-start gap-2 rounded-md border border-border p-2 text-sm"
            >
              <LinkIcon className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link
                  to="/inbox/$conversationId"
                  params={{ conversationId: link.conversation.id }}
                  search={(prev: InboxSearch) => prev}
                  className="font-medium text-link underline"
                >
                  <bdi>{link.conversation.customerName}</bdi>
                </Link>
                <span className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                  <ConversationStatusBadge status={link.conversation.status} />
                  {link.note ? <bdi dir="auto">{link.note}</bdi> : null}
                </span>
              </div>
              {detail.permissions.note ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('inbox.links.remove', { name: link.conversation.customerName })}
                  onClick={() =>
                    remove.mutate(link.id, { onSuccess: () => announce(t('inbox.links.removed')) })
                  }
                >
                  <XIcon aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {detail.permissions.note ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const id = other.trim();
            if (!id) return;
            create.mutate(
              { conversationId: id, ...(note.trim() ? { note: note.trim() } : {}) },
              {
                onSuccess: () => {
                  setOther('');
                  setNote('');
                  announce(t('inbox.links.added'));
                },
              },
            );
          }}
        >
          <TextField
            id={`link-other-${detail.id}`}
            label={t('inbox.links.other')}
            hint={t('inbox.links.otherHint')}
            value={other}
            dir="ltr"
            spellCheck={false}
            onChange={(event) => setOther(event.target.value)}
          />
          <TextField
            id={`link-note-${detail.id}`}
            label={t('inbox.links.note')}
            labelNote={t('app.optional')}
            value={note}
            maxLength={300}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button type="submit" variant="secondary" className="self-start" busy={create.isPending}>
            {t('inbox.links.add')}
          </Button>
          <ActionError error={create.error ?? remove.error} />
        </form>
      ) : null}
    </div>
  );
}

function Reviews({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const reviews = useReviews(detail.id, detail.permissions.review);
  const [rating, setRating] = useState('');
  const [note, setNote] = useState('');
  const create = useConversationChange(
    detail.id,
    (body: { rating: number; note?: string }, tenantId) =>
      api(`/v1/inbox/conversations/${detail.id}/reviews`, {
        method: 'POST',
        tenant: tenantId,
        body,
      }),
    ['reviews'],
  );
  return (
    <div className="flex flex-col gap-3" data-testid="reviews">
      {reviews.error && !reviews.data ? (
        <ErrorPanel
          error={reviews.error}
          onRetry={() => reviews.refetch()}
          retrying={reviews.isRefetching}
        />
      ) : !reviews.data ? (
        <Loading />
      ) : reviews.data.items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('inbox.reviews.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reviews.data.items.map((review) => (
            <li
              key={review.id}
              className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 font-medium">
                  <StarIcon className="size-3.5" aria-hidden="true" />
                  {t('inbox.reviews.rating', { rating: review.rating })}
                </span>
                <span className="text-xs text-text-secondary">
                  {review.subject
                    ? t('inbox.reviews.byAbout', {
                        reviewer: review.reviewer.displayName,
                        subject: review.subject.displayName,
                      })
                    : t('inbox.reviews.by', { reviewer: review.reviewer.displayName })}
                </span>
              </span>
              {review.note ? (
                <p className="text-text">
                  <bdi dir="auto">{review.note}</bdi>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!rating) return;
          create.mutate(
            { rating: Number(rating), ...(note.trim() ? { note: note.trim() } : {}) },
            {
              onSuccess: () => {
                setRating('');
                setNote('');
                announce(t('inbox.reviews.saved'));
              },
            },
          );
        }}
      >
        <ChoiceField
          id={`review-rating-${detail.id}`}
          legend={t('inbox.reviews.ratingLabel')}
          value={rating}
          onValueChange={setRating}
          columns
          choices={[1, 2, 3, 4, 5].map((n) => ({
            value: String(n),
            label: t('inbox.reviews.rating', { rating: n }),
          }))}
        />
        <TextareaField
          id={`review-note-${detail.id}`}
          label={t('inbox.reviews.note')}
          labelNote={t('app.optional')}
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          busy={create.isPending}
          disabled={!rating}
        >
          {t('inbox.reviews.save')}
        </Button>
        <ActionError error={create.error} />
      </form>
    </div>
  );
}

/** The details beside the conversation (board 08, right): customer, tags, fields and links. */
export function ContextPanel({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      <Block id={`ctx-customer-${detail.id}`} title={t('inbox.customer.title')}>
        <Customer detail={detail} />
      </Block>
      <Block id={`ctx-tags-${detail.id}`} title={t('inbox.tags.title')}>
        <Tags detail={detail} />
      </Block>
      <Block id={`ctx-fields-${detail.id}`} title={t('inbox.fields.title')}>
        <Fields detail={detail} />
      </Block>
      <Block id={`ctx-links-${detail.id}`} title={t('inbox.links.title')}>
        <Links detail={detail} />
      </Block>
      {detail.permissions.review ? (
        <Block id={`ctx-reviews-${detail.id}`} title={t('inbox.reviews.title')}>
          <Reviews detail={detail} />
        </Block>
      ) : null}
    </div>
  );
}
