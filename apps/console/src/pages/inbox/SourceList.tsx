import type { SourcePart } from '@hamnivo/contracts';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

type Source = z.infer<typeof SourcePart>;

/**
 * The numbered sources an AI reply cites, linked when they have an address, as the reply's [1],
 * [2] refer to them. Says so when there are none, so a reviewer knows the reply cites nothing.
 */
export function SourceList({ sources }: { sources: readonly Source[] }) {
  const { t } = useTranslation();
  if (sources.length === 0) {
    return <p className="text-xs text-text-secondary">{t('inbox.copilot.noSources')}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-text-secondary">{t('inbox.message.sources')}</p>
      <ol className="flex list-decimal flex-col gap-0.5 ps-5 text-xs" data-testid="source-list">
        {sources.map((source) => (
          <li key={source.sourceId}>
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-link underline"
              >
                <bdi>{source.title}</bdi>
              </a>
            ) : (
              <bdi>{source.title}</bdi>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
