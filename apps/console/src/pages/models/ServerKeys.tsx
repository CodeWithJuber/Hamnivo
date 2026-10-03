import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useTranslation } from 'react-i18next';
import { Section } from '../../components/PageHeader';
import { QueryState } from '../../components/States';
import { type KeyedProvider, type ModelSetupStatus, useModelStatus } from '../../lib/setup';

/** The server's own keys, by the provider they are for. Only whether one is set is ever known. */
const SERVER_KEYS: readonly [keyof ModelSetupStatus['serverKeys'], KeyedProvider][] = [
  ['anthropic', 'anthropic'],
  ['openai', 'openai'],
  ['google', 'google'],
  ['openaiCompatible', 'openai-compatible'],
];

function Row({
  name,
  hint,
  on,
  onLabel,
  offLabel,
  testId,
}: {
  name: string;
  hint?: string;
  on: boolean;
  onLabel: string;
  offLabel: string;
  testId: string;
}) {
  return (
    <li
      data-testid={testId}
      data-set={on ? 'yes' : 'no'}
      className="flex flex-wrap items-start justify-between gap-2 py-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-text">{name}</span>
        {hint ? <span className="text-sm text-text-secondary">{hint}</span> : null}
      </div>
      <StatusBadge tone={on ? 'success' : 'neutral'}>{on ? onLabel : offLabel}</StatusBadge>
    </li>
  );
}

/**
 * What the server itself is set up with: which AI providers it holds a key for, whether Jev is set
 * up and what searches the knowledge. Yes or no only: the keys are never sent to the browser.
 */
export function ServerKeys() {
  const { t } = useTranslation();
  const status = useModelStatus();
  return (
    <Section
      id="server-keys"
      title={t('setup.models.server.title')}
      description={t('setup.models.server.description')}
    >
      <QueryState query={status} label={t('setup.models.server.loading')}>
        {(data) => (
          <ul className="divide-y divide-border" data-testid="server-keys">
            {SERVER_KEYS.map(([key, provider]) => (
              <Row
                key={key}
                testId={`server-key-${provider}`}
                name={t(`editor.providers.${provider}`)}
                on={data.serverKeys[key]}
                onLabel={t('setup.models.server.set')}
                offLabel={t('setup.models.server.notSet')}
              />
            ))}
            <Row
              testId="server-jev"
              name={t('setup.models.server.jev')}
              hint={t('setup.models.server.jevHint')}
              on={data.jev.configured}
              onLabel={t('setup.models.server.jevOn')}
              offLabel={t('setup.models.server.jevOff')}
            />
            <Row
              testId="server-embeddings"
              name={t('setup.models.server.embeddings')}
              hint={
                data.embeddings.provider === 'mock'
                  ? t('setup.models.server.embeddingsMock')
                  : data.embeddings.ready
                    ? t('setup.models.server.embeddingsReady', {
                        provider: t(`editor.providers.${data.embeddings.provider}`),
                      })
                    : t('setup.models.server.embeddingsMissing', {
                        provider: t(`editor.providers.${data.embeddings.provider}`),
                      })
              }
              on={data.embeddings.provider !== 'mock' && data.embeddings.ready}
              onLabel={t('setup.models.server.embeddingsOn')}
              offLabel={
                data.embeddings.provider === 'mock'
                  ? t('setup.models.server.embeddingsBasic')
                  : t('setup.models.server.embeddingsNotReady')
              }
            />
          </ul>
        )}
      </QueryState>
    </Section>
  );
}
