import { Button } from '@hamnivo/ui/components/button';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { Link } from '@tanstack/react-router';
import { CircleCheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Section } from '../../components/PageHeader';
import { QueryState } from '../../components/States';
import { formatNumber } from '../../lib/format';
import { useInboxList } from '../../lib/inbox';

function Count({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-4"
      data-testid={testId}
    >
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="text-2xl font-semibold text-text tabular-nums">{formatNumber(value)}</dd>
    </div>
  );
}

/**
 * Home for staff who do not run the workspace: how many customers wait for a person, and how
 * many chats are assigned to them, from the inbox's own counts (people see only the
 * conversations their grants reach). The way into the inbox stays in view while this loads.
 */
export function YourChats() {
  const { t } = useTranslation();
  const list = useInboxList({}, 1);
  const counts = list.data?.pages[0]?.counts;
  return (
    <Section
      id="overview-chats"
      title={t('overview.chats.title')}
      description={t('overview.chats.description')}
      actions={
        <Button asChild>
          <Link to="/inbox">{t('overview.chats.open')}</Link>
        </Button>
      }
    >
      <QueryState
        query={{ ...list, data: counts }}
        label={t('overview.chats.loading')}
        skeleton={
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-20 rounded-lg" />
            <Skeleton className="h-20 rounded-lg" />
          </div>
        }
      >
        {(value) => (
          <div className="flex flex-col gap-3">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Count
                label={t('overview.chats.waiting')}
                value={value.unassigned}
                testId="chats-waiting"
              />
              <Count label={t('overview.chats.mine')} value={value.mine} testId="chats-mine" />
            </dl>
            {value.unassigned === 0 && value.mine === 0 ? (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
                {t('overview.chats.caughtUp')}
              </p>
            ) : null}
          </div>
        )}
      </QueryState>
    </Section>
  );
}
