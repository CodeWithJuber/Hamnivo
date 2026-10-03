import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { CircleIcon, ExternalLinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ErrorPanel, ListSkeleton } from '../../components/States';
import { formatRelative } from '../../lib/format';
import {
  countryName,
  deviceLine,
  formatSpan,
  pathOf,
  useConversationVisitor,
  type VisitorCard,
} from '../../lib/visitors';
import { languageName, timeOfDay } from './parts';

/** A page of the visitor's: its title (or address), as a link when the address may be opened. */
function PageLink({ url, title }: { url: string; title: string | null }) {
  const { t } = useTranslation();
  const label = title?.trim() || t('inboxAlerts.visitor.untitled');
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('inboxAlerts.visitor.openPage', { page: label })}
      className="group inline-flex min-w-0 max-w-full flex-col rounded-sm text-start hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-center gap-1 font-medium text-text">
        <bdi className="truncate">{label}</bdi>
        <ExternalLinkIcon className="size-3 shrink-0 text-text-muted" aria-hidden="true" />
      </span>
      <span dir="ltr" className="truncate text-xs text-text-secondary">
        {pathOf(url)}
      </span>
    </a>
  );
}

/** The visit as staff read it: where the visitor is, how long, from where and on what. */
export function VisitorCardView({ card }: { card: VisitorCard }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const span = formatSpan(card.timeOnSiteSeconds, locale);
  const country = countryName(card.country, locale);
  const language = languageName(card.language);
  return (
    <div className="flex flex-col gap-3" data-testid="visitor-card">
      <div>
        {card.online ? (
          <StatusBadge
            tone="success"
            icon={<CircleIcon className="size-2.5 fill-current" aria-hidden="true" />}
          >
            {t('inboxAlerts.visitor.online')}
          </StatusBadge>
        ) : (
          <StatusBadge tone="neutral" icon={<CircleIcon className="size-2.5" aria-hidden="true" />}>
            {t('inboxAlerts.visitor.left', { when: formatRelative(card.lastSeenAt) })}
          </StatusBadge>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-text-secondary">{t('inboxAlerts.visitor.currentPage')}</dt>
        <dd className="min-w-0">
          <PageLink url={card.currentPage.url} title={card.currentPage.title} />
        </dd>
        <dt className="text-text-secondary">{t('inboxAlerts.visitor.visits')}</dt>
        <dd className="text-text">{card.visitCount}</dd>
        <dt className="text-text-secondary">{t('inboxAlerts.visitor.visitor')}</dt>
        <dd className="text-text">
          {card.returning ? t('inboxAlerts.visitor.returning') : t('inboxAlerts.visitor.new')}
        </dd>
        <dt className="text-text-secondary">{t('inboxAlerts.visitor.timeOnSite')}</dt>
        <dd className="text-text">{span ?? t('inboxAlerts.visitor.underMinute')}</dd>
        {country ? (
          <>
            <dt className="text-text-secondary">{t('inboxAlerts.visitor.country')}</dt>
            <dd className="text-text">{country}</dd>
          </>
        ) : null}
        <dt className="text-text-secondary">{t('inboxAlerts.visitor.device')}</dt>
        <dd className="text-text">
          <bdi>{deviceLine(card.device, t(`inboxAlerts.visitor.types.${card.device.type}`))}</bdi>
        </dd>
        {language ? (
          <>
            <dt className="text-text-secondary">{t('inboxAlerts.visitor.language')}</dt>
            <dd className="text-text">
              <bdi>{language}</bdi>
            </dd>
          </>
        ) : null}
        {card.referrer ? (
          <>
            <dt className="text-text-secondary">{t('inboxAlerts.visitor.cameFrom')}</dt>
            <dd dir="ltr" className="min-w-0 truncate text-text" title={card.referrer}>
              {card.referrer.replace(/^https?:\/\//, '')}
            </dd>
          </>
        ) : null}
      </dl>
      {card.pages.length > 0 ? (
        <section aria-label={t('inboxAlerts.visitor.pages')} className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold text-text-secondary">
            {t('inboxAlerts.visitor.pages')}
          </h4>
          <ol className="flex flex-col gap-1.5" data-testid="visitor-pages">
            {card.pages.map((page) => (
              <li
                key={`${page.viewedAt}-${page.url}`}
                className="flex items-start justify-between gap-2 text-sm"
              >
                <PageLink url={page.url} title={page.title} />
                <time dateTime={page.viewedAt} className="shrink-0 text-xs text-text-secondary">
                  {timeOfDay(page.viewedAt)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <p className="text-xs text-text-secondary">{t('inboxAlerts.visitor.privacy')}</p>
    </div>
  );
}

/** What the website knows about the customer's browser: pages, device, country and visits. */
export function VisitorDetails({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const visitor = useConversationVisitor(conversationId);
  if (visitor.error && !visitor.data) {
    return (
      <ErrorPanel
        error={visitor.error}
        onRetry={() => visitor.refetch()}
        retrying={visitor.isRefetching}
      />
    );
  }
  if (!visitor.data) return <ListSkeleton rows={2} />;
  if (!visitor.data.visitor) {
    return (
      <p className="text-sm text-text-secondary" data-testid="visitor-none">
        {visitor.data.tracking ? t('inboxAlerts.visitor.none') : t('inboxAlerts.visitor.notNoted')}
      </p>
    );
  }
  return <VisitorCardView card={visitor.data.visitor} />;
}
