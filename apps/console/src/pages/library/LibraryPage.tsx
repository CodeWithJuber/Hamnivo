import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, MessageSquareTextIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandPicker, useChosenBrand } from '../../components/BrandPicker';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden, QueryState } from '../../components/States';
import { isNotSetUp, useLibraryReplies, useLibraryTags } from '../../lib/library';
import { useTenant } from '../../lib/tenant';
import { RepliesSection } from './RepliesSection';
import { TagsSection } from './TagsSection';

/** What a brand's lists show, or why they cannot yet: no chat account means nothing to list. */
function BrandLibrary({ brandId, brandName }: { brandId: string; brandName: string }) {
  const { t } = useTranslation();
  const replies = useLibraryReplies(brandId);
  const tags = useLibraryTags(brandId);
  if (isNotSetUp(replies.error) || isNotSetUp(tags.error)) {
    return (
      <EmptyState
        kind="no-records"
        title={t('inboxAlerts.library.notSetUp.title', { name: brandName })}
        description={t('inboxAlerts.library.notSetUp.description')}
        icon={<MessageSquareTextIcon className="size-6 text-text-muted" aria-hidden="true" />}
        action={
          <Button asChild variant="secondary">
            <Link to="/brands">{t('inboxAlerts.library.notSetUp.action')}</Link>
          </Button>
        }
      />
    );
  }
  return (
    <>
      <RepliesSection brandId={brandId} />
      <TagsSection brandId={brandId} />
    </>
  );
}

/**
 * Saved replies and tags for one brand, for people who manage the inbox. Both lists live in the
 * brand's chat account, so a change reaches everyone who answers customers at once. The page is
 * reached from the inbox; `requested` is the brand in the link, if any.
 */
export function LibraryPage({
  requested,
  onBrand,
}: {
  requested: string | undefined;
  onBrand: (brandId: string) => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { brands, active, chosen } = useChosenBrand(requested);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('inboxAlerts.library.title')}
        description={t('inboxAlerts.library.description')}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/inbox" search={{}}>
              <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
              {t('inboxAlerts.library.back')}
            </Link>
          </Button>
        }
      />
      {!can('inbox.manage') ? (
        <Forbidden
          title={t('inboxAlerts.library.forbidden.title')}
          description={t('inboxAlerts.library.forbidden.description')}
        />
      ) : (
        <QueryState
          query={{
            data: brands.items,
            error: brands.error,
            isPending: brands.pending,
            isRefetching: brands.isRefetching,
            refetch: brands.refetch,
          }}
          label={t('inboxAlerts.library.loading')}
          permitted={brands.permitted}
        >
          {() =>
            chosen ? (
              <>
                <BrandPicker
                  id="library-brand"
                  label={t('inboxAlerts.library.brand')}
                  brands={active}
                  value={chosen.id}
                  onChange={onBrand}
                />
                <div key={chosen.id} className="flex flex-col gap-6">
                  <BrandLibrary brandId={chosen.id} brandName={chosen.name} />
                </div>
              </>
            ) : (
              <p className="text-sm text-text-secondary">{t('inboxAlerts.library.noBrands')}</p>
            )
          }
        </QueryState>
      )}
    </div>
  );
}
