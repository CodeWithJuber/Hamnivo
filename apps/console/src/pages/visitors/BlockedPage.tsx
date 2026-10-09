import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, BanIcon, ShieldCheckIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { SelectField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden, QueryState } from '../../components/States';
import {
  type BlockListStatus,
  isActive,
  standingOf,
  useLiftBlock,
  useVisitorBlocks,
  type VisitorBlock,
} from '../../lib/blocks';
import { DOCS } from '../../lib/docs';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useBrandRefs } from '../../lib/names';
import { useTenant } from '../../lib/tenant';

const COLUMNS = ['who', 'reason', 'by', 'when', 'expires', 'actions'] as const;

/** "Until unblocked", the time it ends, or how it ended: always in words. */
function Expires({ block }: { block: VisitorBlock }) {
  const { t } = useTranslation();
  const standing = standingOf(block);
  switch (standing.kind) {
    case 'never':
      return <span>{t('inbox.blocking.page.standing.never')}</span>;
    case 'until':
      return <time dateTime={standing.at}>{formatDateTime(standing.at)}</time>;
    case 'expired':
      return (
        <span className="text-text-secondary">
          {t('inbox.blocking.page.standing.expired', { time: formatDateTime(standing.at) })}
        </span>
      );
    case 'lifted':
      return (
        <span className="text-text-secondary">
          {standing.by
            ? t('inbox.blocking.page.standing.liftedBy', {
                name: standing.by,
                time: formatDateTime(standing.at),
              })
            : t('inbox.blocking.page.standing.lifted', { time: formatDateTime(standing.at) })}
        </span>
      );
  }
}

function BlockRow({
  block,
  brandName,
  onUnblock,
}: {
  block: VisitorBlock;
  /** Shown when the person sees more than one brand. */
  brandName: string | null;
  onUnblock: (block: VisitorBlock) => void;
}) {
  const { t } = useTranslation();
  const active = isActive(block);
  return (
    <TableRow
      data-testid="block-row"
      data-block-id={block.id}
      data-active={active ? 'true' : 'false'}
    >
      <TableCell className="min-w-36">
        <div className="flex flex-col items-start gap-1">
          <span className="font-medium text-text">
            <bdi>{block.who}</bdi>
          </span>
          {block.signedIn ? (
            <StatusBadge tone="info" icon={null}>
              {t('inbox.blocking.page.signedIn')}
            </StatusBadge>
          ) : null}
          {brandName ? (
            <span className="text-xs text-text-secondary">
              <bdi>{brandName}</bdi>
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-72 min-w-48 whitespace-normal">
        <bdi dir="auto" className="break-words">
          {block.reason}
        </bdi>
      </TableCell>
      <TableCell className="min-w-32 whitespace-normal">
        {block.createdBy ? (
          <bdi>{block.createdBy.name}</bdi>
        ) : (
          <span className="text-text-secondary">{t('inbox.blocking.page.formerStaff')}</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <time dateTime={block.createdAt} title={formatDateTime(block.createdAt)}>
          {formatRelative(block.createdAt)}
        </time>
      </TableCell>
      <TableCell className="min-w-32 whitespace-normal">
        <Expires block={block} />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          {block.conversationId ? (
            <Button asChild variant="secondary" size="sm">
              <Link
                to="/inbox/$conversationId"
                params={{ conversationId: block.conversationId }}
                search={{}}
                aria-label={t('inbox.blocking.page.openChatFor', { name: block.who })}
              >
                {t('inbox.blocking.page.openChat')}
              </Link>
            </Button>
          ) : null}
          {active ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label={t('inbox.blocking.page.unblockFor', { name: block.who })}
              onClick={() => onUnblock(block)}
              data-testid="unblock"
            >
              <ShieldCheckIcon aria-hidden="true" />
              {t('inbox.blocking.page.unblock')}
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Visitors blocked from chatting (H20), newest first: who, why, by whom, when and until when, with
 * the chat it came from. Unblocking asks first, then the visitor can chat again at once. For
 * people who may block visitors; the list is limited to the brands their role reaches.
 */
export function BlockedPage({
  status,
  brandId,
  onChange,
}: {
  status: BlockListStatus;
  brandId: string;
  onChange: (next: { status?: BlockListStatus; brand?: string }) => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const permitted = can('visitors.block');
  const brands = useBrandRefs();
  const blocks = useVisitorBlocks(brandId, status);
  const lift = useLiftBlock();
  // The block stays named while the dialog closes.
  const [unblocking, setUnblocking] = useState<VisitorBlock | null>(null);
  const [confirming, setConfirming] = useState(false);

  const brandNames = useMemo(
    () => new Map((brands.items ?? []).map((brand) => [brand.id, brand.name])),
    [brands.items],
  );
  const manyBrands = brandNames.size > 1;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('inbox.blocking.page.title')}
        description={t('inbox.blocking.page.description')}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/inbox" search={{}}>
              <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
              {t('inbox.blocking.page.back')}
            </Link>
          </Button>
        }
      />
      {permitted ? (
        <>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3" data-testid="block-filters">
            <div className="w-56">
              <SelectField
                id="blocked-status"
                label={t('inbox.blocking.page.show')}
                value={status}
                onChange={(event) =>
                  onChange({ status: event.target.value === 'all' ? 'all' : 'active' })
                }
                options={[
                  { value: 'active', label: t('inbox.blocking.page.filters.active') },
                  { value: 'all', label: t('inbox.blocking.page.filters.all') },
                ]}
              />
            </div>
            {manyBrands ? (
              <div className="w-56">
                <SelectField
                  id="blocked-brand"
                  label={t('inbox.blocking.page.brand')}
                  value={brandId}
                  onChange={(event) => onChange({ brand: event.target.value })}
                  options={[
                    { value: '', label: t('inbox.blocking.page.allBrands') },
                    ...[...brandNames].map(([value, label]) => ({ value, label })),
                  ]}
                />
              </div>
            ) : null}
            <GuideLink href={DOCS.inbox.blockingVisitors}>
              {t('inbox.blocking.page.guide')}
            </GuideLink>
          </div>
          <QueryState
            query={blocks}
            label={t('inbox.blocking.page.loading')}
            isEmpty={(data) => data.items.length === 0}
            empty={
              <EmptyState
                kind="no-records"
                title={
                  status === 'all'
                    ? t('inbox.blocking.page.empty.allTitle')
                    : t('inbox.blocking.page.empty.title')
                }
                description={t('inbox.blocking.page.empty.description')}
                icon={<BanIcon className="size-6 text-text-muted" aria-hidden="true" />}
                action={
                  <Button asChild variant="secondary">
                    <Link to="/visitors">{t('inboxAlerts.live.link')}</Link>
                  </Button>
                }
              />
            }
          >
            {(data) => (
              <div className="rounded-xl border border-border bg-surface shadow-sm">
                <Table data-testid="blocks-table">
                  <TableCaption className="sr-only">{t('inbox.blocking.page.table')}</TableCaption>
                  <TableHeader>
                    <TableRow>
                      {COLUMNS.map((column) => (
                        <TableHead key={column} className="text-start">
                          {t(`inbox.blocking.page.columns.${column}`)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((block) => (
                      <BlockRow
                        key={block.id}
                        block={block}
                        brandName={manyBrands ? (brandNames.get(block.brandId) ?? null) : null}
                        onUnblock={(chosen) => {
                          setUnblocking(chosen);
                          setConfirming(true);
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </QueryState>
        </>
      ) : (
        <Forbidden
          title={t('inbox.blocking.page.forbidden.title')}
          description={t('inbox.blocking.page.forbidden.description')}
        />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('inbox.blocking.page.confirm.title', { name: unblocking?.who ?? '' })}
        confirmLabel={t('inbox.blocking.page.confirm.submit')}
        failureNote={t('inbox.blocking.page.confirm.failed', { name: unblocking?.who ?? '' })}
        testId="unblock-dialog"
        onConfirm={async () => {
          if (!unblocking) return;
          await lift.mutateAsync(unblocking.id);
          announce(t('inbox.blocking.page.confirm.done', { name: unblocking.who }));
        }}
      >
        <p>{t('inbox.blocking.page.confirm.body')}</p>
      </ConfirmDialog>
    </div>
  );
}
