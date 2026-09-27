import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { cn } from '@hamnivo/ui/lib/utils';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ExternalLinkIcon,
  FileTextIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  UploadIcon,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/AppDialog';
import {
  DocumentStateBadge,
  FreshnessBadge,
  SourceStatusBadge,
  VersionStateBadge,
  VisibilityBadge,
} from '../components/Badges';
import { ChoiceField, SelectField, TextField } from '../components/Fields';
import { SourceDialog, UploadDialog } from '../components/KnowledgeDialogs';
import { PageHeader, Section } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { api } from '../lib/api';
import { formatBytes, formatDateTime, formatNumber, formatScore } from '../lib/format';
import { useBrandRefs, useNames } from '../lib/names';
import { keys, useDocuments, useSources, useStudioMutation } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type {
  DocumentVersion,
  KnowledgeDocument,
  KnowledgePassage,
  KnowledgeSource,
} from '../lib/types';

const settlingState = (d: KnowledgeDocument) =>
  [d.latest?.state, d.current?.state].some((s) => s === 'queued' || s === 'processing');

function VersionFacts({ version }: { version: DocumentVersion }) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      <dt className="text-text-secondary">{t('knowledge.detail.size')}</dt>
      <dd>{formatBytes(version.byteSize)}</dd>
      <dt className="text-text-secondary">{t('knowledge.detail.passages')}</dt>
      <dd>{formatNumber(version.chunkCount)}</dd>
      <dt className="text-text-secondary">{t('knowledge.detail.added')}</dt>
      <dd>{formatDateTime(version.createdAt)}</dd>
      {version.readyAt ? (
        <>
          <dt className="text-text-secondary">{t('knowledge.detail.readySince')}</dt>
          <dd>{formatDateTime(version.readyAt)}</dd>
        </>
      ) : null}
      {version.validUntil ? (
        <>
          <dt className="text-text-secondary">{t('knowledge.detail.validUntil')}</dt>
          <dd>{formatDateTime(version.validUntil)}</dd>
        </>
      ) : null}
    </dl>
  );
}

function DocumentDetail({
  document,
  sourceId,
  onBack,
}: {
  document: KnowledgeDocument;
  sourceId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [uploading, setUploading] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const act = useStudioMutation(
    (action: 'review' | 'retire', tenant) =>
      api<KnowledgeDocument>(`/v1/admin/knowledge/documents/${document.id}/${action}`, {
        method: 'POST',
        tenant,
      }),
    [keys.documents(sourceId), keys.sources],
  );
  const manage = can('knowledge.manage') && document.status === 'active';
  const newest = document.latest;

  // Choosing a document moves focus to its details (on narrow screens they replace the list).
  const documentId = document.id;
  useEffect(() => {
    if (documentId) window.document.getElementById('document-title')?.focus();
  }, [documentId]);

  return (
    <section
      aria-labelledby="document-title"
      data-testid="document-detail"
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <Button
        variant="link"
        className="h-auto self-start p-0 has-[>svg]:px-0 xl:hidden"
        onClick={onBack}
      >
        <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
        {t('knowledge.detail.back')}
      </Button>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-text-secondary">{t('knowledge.detail.title')}</p>
        <h2 id="document-title" tabIndex={-1} className="text-lg font-semibold text-text">
          <bdi>{document.title}</bdi>
        </h2>
      </div>
      <div className="flex flex-wrap gap-2">
        <DocumentStateBadge document={document} />
        {document.current ? <FreshnessBadge freshness={document.freshness} /> : null}
      </div>
      {document.url ? (
        <a
          href={document.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-sm text-link underline underline-offset-4 hover:no-underline"
        >
          {t('knowledge.detail.original')}
          <ExternalLinkIcon className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
        </a>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text">{t('knowledge.detail.answering')}</h3>
        {document.current ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {t('knowledge.detail.version', { version: document.current.version })}
              </span>
              <VersionStateBadge state={document.current.state} />
            </div>
            <VersionFacts version={document.current} />
          </div>
        ) : (
          <p className="text-sm text-text-secondary">{t('knowledge.detail.noneAnswering')}</p>
        )}
      </div>

      {newest ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-text">{t('knowledge.detail.newest')}</h3>
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {t('knowledge.detail.version', { version: newest.version })}
              </span>
              <VersionStateBadge state={newest.state} />
            </div>
            {newest.error ? (
              <p className="text-sm text-danger" data-testid="rejection-reason">
                <bdi dir="auto">{t('knowledge.detail.reason', { reason: newest.error })}</bdi>
              </p>
            ) : null}
            {document.current && (newest.state === 'queued' || newest.state === 'processing') ? (
              <p className="text-sm text-text-secondary">
                {t('knowledge.detail.keepsAnswering', { version: document.current.version })}
              </p>
            ) : null}
            <VersionFacts version={newest} />
          </div>
        </div>
      ) : null}

      <p className="text-sm text-text-secondary">
        {t('knowledge.detail.reviewed')}:{' '}
        {document.reviewedAt
          ? formatDateTime(document.reviewedAt)
          : t('knowledge.detail.neverReviewed')}
      </p>

      <ActionError error={act.error} />
      {manage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            busy={act.isPending && act.variables === 'review'}
            disabled={!document.current}
            onClick={async () => {
              try {
                await act.mutateAsync('review');
                announce(t('knowledge.detail.markedReviewed', { title: document.title }));
              } catch {
                // Shown above the actions.
              }
            }}
          >
            {t('knowledge.detail.markReviewed')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setUploading(true)}>
            <UploadIcon aria-hidden="true" />
            {t('knowledge.detail.newVersion')}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setRetiring(true)}>
            {t('knowledge.detail.retire')}
          </Button>
        </div>
      ) : null}

      <UploadDialog
        open={uploading}
        onOpenChange={setUploading}
        sourceId={sourceId}
        document={document}
      />
      <ConfirmDialog
        open={retiring}
        onOpenChange={setRetiring}
        title={t('knowledge.detail.retireTitle', { title: document.title })}
        confirmLabel={t('knowledge.detail.retireSubmit')}
        variant="destructive-solid"
        onConfirm={async () => {
          await act.mutateAsync('retire');
          announce(t('knowledge.detail.retired', { title: document.title }));
        }}
      >
        <p>{t('knowledge.detail.retireBody')}</p>
      </ConfirmDialog>
    </section>
  );
}

function SearchPreview({ defaultBrandId }: { defaultBrandId: string | undefined }) {
  const { t } = useTranslation();
  const { tenantId } = useTenant();
  const announce = useAnnouncer();
  const brands = useBrandRefs();
  const [brandId, setBrandId] = useState('');
  const [audience, setAudience] = useState<'customer' | 'staff'>('customer');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [results, setResults] = useState<KnowledgePassage[] | null>(null);
  const chosenBrand = brandId || defaultBrandId || brands.items?.[0]?.id || '';

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) {
      setError(t('knowledge.search.queryRequired'));
      return;
    }
    setError(undefined);
    setBusy(true);
    setFailure(null);
    try {
      const response = await api<{ items: KnowledgePassage[] }>('/v1/admin/knowledge/search', {
        method: 'POST',
        tenant: tenantId,
        body: { query: query.trim(), brandId: chosenBrand, audience, limit: 5 },
      });
      setResults(response.items);
      announce(t('knowledge.search.found', { total: formatNumber(response.items.length) }));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="knowledge-search"
      title={t('knowledge.search.title')}
      description={t('knowledge.search.description')}
    >
      {(brands.items ?? []).length === 0 && !brands.pending ? (
        <p className="text-sm text-text-secondary">{t('knowledge.search.noBrands')}</p>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={search} noValidate>
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              id="search-brand"
              label={t('knowledge.search.brand')}
              value={chosenBrand}
              onChange={(event) => setBrandId(event.target.value)}
              options={(brands.items ?? []).map((b) => ({ value: b.id, label: b.name }))}
            />
            <ChoiceField
              id="search-audience"
              legend={t('knowledge.search.audience')}
              value={audience}
              onValueChange={(value) => setAudience(value as 'customer' | 'staff')}
              choices={[
                { value: 'customer', label: t('knowledge.search.audiences.customer') },
                { value: 'staff', label: t('knowledge.search.audiences.staff') },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60 flex-1">
              <TextField
                id="search-query"
                label={t('knowledge.search.query')}
                type="search"
                dir="auto"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                error={error}
              />
            </div>
            <Button type="submit" busy={busy} className={error ? 'mb-7' : undefined}>
              {busy ? null : <SearchIcon aria-hidden="true" />}
              {t('knowledge.search.submit')}
            </Button>
          </div>
        </form>
      )}
      <ActionError error={failure} />
      {results ? (
        <div className="flex flex-col gap-3" data-testid="search-results">
          <h3 className="text-sm font-semibold text-text">
            {t('knowledge.search.results')} ·{' '}
            {t('knowledge.search.found', { total: formatNumber(results.length) })}
          </h3>
          {results.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('knowledge.search.empty')}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {results.map((passage, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: passages have no id; rank is the order
                  key={index}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3"
                  data-testid="passage"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-text">
                      <bdi>{passage.title}</bdi>
                      {passage.heading ? (
                        <span className="text-text-secondary">
                          {' '}
                          · <bdi>{passage.heading}</bdi>
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-text-secondary">
                      <span>{t('knowledge.search.version', { version: passage.version })}</span>
                      <span data-testid="passage-score">
                        {t('knowledge.search.score', { score: formatScore(passage.score) })}
                      </span>
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-line text-text" dir="auto">
                    {passage.text}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </Section>
  );
}

function SourceList({
  sources,
  selected,
  onEdit,
}: {
  sources: KnowledgeSource[];
  selected: string | undefined;
  onEdit: (source: KnowledgeSource) => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const names = useNames();
  return (
    <ul className="flex flex-col gap-2" data-testid="sources">
      {sources.map((source) => {
        const active = source.id === selected;
        return (
          <li
            key={source.id}
            className={cn(
              'relative flex flex-col gap-2 rounded-lg border p-3',
              active ? 'border-text bg-surface-muted' : 'border-border',
            )}
          >
            <Link
              to="/knowledge"
              search={{ source: source.id }}
              aria-current={active ? 'true' : undefined}
              className="font-medium text-text underline-offset-4 hover:underline"
            >
              <bdi>{source.name}</bdi>
            </Link>
            <span className="text-xs text-text-secondary">
              <bdi>{names.brand(source.brandId) ?? source.brandId}</bdi>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <VisibilityBadge visibility={source.visibility} />
              {source.status !== 'active' ? <SourceStatusBadge status={source.status} /> : null}
            </div>
            <p className="text-xs text-text-secondary">
              {t('knowledge.sources.documents', { total: formatNumber(source.documentCount) })} ·{' '}
              {source.reviewEveryDays
                ? t('knowledge.sources.review', { days: formatNumber(source.reviewEveryDays) })
                : t('knowledge.sources.noReview')}
            </p>
            {can('knowledge.manage') ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => onEdit(source)}
                aria-label={t('knowledge.sources.settings', { name: source.name })}
              >
                <Settings2Icon aria-hidden="true" />
                {t('knowledge.sourceForm.editTitle')}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Knowledge (board 14: HNV-14-01 sources, 14-02 ingesting, 14-03 failure or stale, 14-04 preview). */
export function KnowledgePage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/knowledge' });
  const sources = useSources();
  const [sourceDialog, setSourceDialog] = useState<{ source?: KnowledgeSource } | null>(null);
  const [uploading, setUploading] = useState(false);
  const selectedSource =
    sources.data?.items.find((s) => s.id === search.source) ?? sources.data?.items[0];
  const documents = useDocuments(selectedSource?.id);
  const selectedDocument = documents.data?.items.find((d) => d.id === search.document);
  const showingDetail = Boolean(selectedDocument);
  const settling = (documents.data?.items ?? []).some(settlingState);

  const select = (documentId: string | undefined) =>
    navigate({
      to: '/knowledge',
      search: {
        ...(selectedSource ? { source: selectedSource.id } : {}),
        ...(documentId ? { document: documentId } : {}),
      },
    });

  const addSource = can('knowledge.manage') ? (
    <Button onClick={() => setSourceDialog({})}>
      <PlusIcon aria-hidden="true" />
      {t('knowledge.sources.add')}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('knowledge.title')}
        description={t('knowledge.description')}
        actions={addSource}
      />
      <QueryState
        query={sources}
        label={t('knowledge.sources.loading')}
        permitted={can('knowledge.read')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('knowledge.sources.empty.title')}
            description={t('knowledge.sources.empty.description')}
            icon={<BookOpenIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={addSource ?? <span />}
          />
        }
      >
        {(data) => (
          <div className="grid gap-6 xl:grid-cols-[17rem_minmax(0,1fr)_22rem]">
            <section
              aria-labelledby="sources-title"
              className={cn('flex min-w-0 flex-col gap-3', showingDetail && 'hidden xl:flex')}
            >
              <h2 id="sources-title" className="text-lg font-semibold text-text">
                {t('knowledge.sources.title')}
              </h2>
              <SourceList
                sources={data.items}
                selected={selectedSource?.id}
                onEdit={(source) => setSourceDialog({ source })}
              />
            </section>

            <section
              aria-labelledby="documents-title"
              className={cn(
                'flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm',
                showingDetail && 'hidden xl:flex',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="documents-title" className="text-lg font-semibold text-text">
                  {t('knowledge.documents.title')}
                  {selectedSource ? (
                    <span className="text-text-secondary">
                      {' '}
                      · <bdi>{selectedSource.name}</bdi>
                    </span>
                  ) : null}
                </h2>
                {can('knowledge.manage') &&
                selectedSource &&
                selectedSource.status !== 'retired' ? (
                  <Button size="sm" onClick={() => setUploading(true)}>
                    <PlusIcon aria-hidden="true" />
                    {t('knowledge.documents.add')}
                  </Button>
                ) : null}
              </div>
              {settling ? (
                <p className="text-xs text-text-secondary" role="status">
                  {t('knowledge.documents.polling')}
                </p>
              ) : null}
              {selectedSource ? (
                <QueryState
                  query={documents}
                  label={t('knowledge.documents.loading')}
                  isEmpty={(docs) => docs.items.length === 0}
                  empty={
                    <EmptyState
                      kind="no-records"
                      title={t('knowledge.documents.empty.title')}
                      description={t('knowledge.documents.empty.description')}
                      icon={<FileTextIcon className="size-6 text-text-muted" aria-hidden="true" />}
                      action={
                        can('knowledge.manage') ? (
                          <Button onClick={() => setUploading(true)}>
                            {t('knowledge.documents.add')}
                          </Button>
                        ) : (
                          <span />
                        )
                      }
                    />
                  }
                >
                  {(docs) => (
                    <Table data-testid="documents-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-start">
                            {t('knowledge.documents.columns.title')}
                          </TableHead>
                          <TableHead className="text-start">
                            {t('knowledge.documents.columns.state')}
                          </TableHead>
                          <TableHead className="text-start">
                            {t('knowledge.documents.columns.freshness')}
                          </TableHead>
                          <TableHead className="text-start">
                            {t('knowledge.documents.columns.version')}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {docs.items.map((document) => (
                          <TableRow
                            key={document.id}
                            data-document={document.title}
                            data-doc-state={document.latest?.state ?? document.current?.state ?? ''}
                            data-selected={
                              document.id === selectedDocument?.id ? 'true' : undefined
                            }
                            className="data-[selected=true]:bg-surface-muted"
                          >
                            <TableCell className="max-w-64 whitespace-normal">
                              <Button
                                variant="link"
                                className="h-auto p-0 text-start whitespace-normal"
                                onClick={() => select(document.id)}
                                aria-label={t('knowledge.documents.select', {
                                  title: document.title,
                                })}
                                aria-current={
                                  document.id === selectedDocument?.id ? 'true' : undefined
                                }
                              >
                                <bdi>{document.title}</bdi>
                              </Button>
                              {(document.latest ?? document.current)?.error ? (
                                <span className="block text-xs text-danger">
                                  <bdi dir="auto">
                                    {(document.latest ?? document.current)?.error}
                                  </bdi>
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <DocumentStateBadge document={document} />
                            </TableCell>
                            <TableCell>
                              {document.current ? (
                                <FreshnessBadge freshness={document.freshness} />
                              ) : (
                                <span className="text-text-muted">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {formatNumber((document.latest ?? document.current)?.version ?? null)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </QueryState>
              ) : (
                <p className="text-sm text-text-secondary">{t('knowledge.documents.pick')}</p>
              )}
            </section>

            <div className={cn('min-w-0', !showingDetail && 'hidden xl:block')}>
              {selectedDocument && selectedSource ? (
                <DocumentDetail
                  document={selectedDocument}
                  sourceId={selectedSource.id}
                  onBack={() => {
                    void select(undefined).then(() =>
                      window.document.getElementById('documents-title')?.focus(),
                    );
                  }}
                />
              ) : (
                <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
                  {t('knowledge.documents.pick')}
                </p>
              )}
            </div>
          </div>
        )}
      </QueryState>

      {can('knowledge.read') ? <SearchPreview defaultBrandId={selectedSource?.brandId} /> : null}

      <SourceDialog
        open={sourceDialog !== null}
        onOpenChange={(open) => {
          if (!open) setSourceDialog(null);
        }}
        source={sourceDialog?.source}
        onSaved={(saved) => {
          if (!sourceDialog?.source)
            void navigate({ to: '/knowledge', search: { source: saved.id } });
        }}
      />
      {selectedSource ? (
        <UploadDialog
          open={uploading}
          onOpenChange={setUploading}
          sourceId={selectedSource.id}
          onQueued={(document) => void select(document.id)}
        />
      ) : null}
    </div>
  );
}
