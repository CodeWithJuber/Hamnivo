import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../../components/Fields';
import type { KeyedProvider } from '../../lib/setup';
import {
  CUSTOM_MODEL,
  MODEL_CATALOG,
  modelDropdownValue,
  recommendedModel,
} from '../../lib/setup-data';

/** What the picker holds: a listed model, or `custom` with the name typed in. */
export interface ModelPick {
  choice: string;
  custom: string;
}

/** The model a provider starts from: its recommended one, or the custom entry when it has none. */
export const defaultPick = (provider: KeyedProvider): ModelPick => ({
  choice: recommendedModel(provider) ?? CUSTOM_MODEL,
  custom: '',
});

/** The picker for a model name that is already known (a connection's first allowed model). */
export const pickOf = (provider: KeyedProvider, modelId: string | undefined): ModelPick =>
  modelId
    ? { choice: modelDropdownValue(provider, modelId), custom: modelId }
    : defaultPick(provider);

/** The model name the picker stands for, or '' while a custom name is still empty. */
export const modelOf = (pick: ModelPick): string =>
  pick.choice === CUSTOM_MODEL ? pick.custom.trim() : pick.choice;

/**
 * A dropdown of the models a provider is known for, ending in "Another model", where the name is
 * typed. A server of your own (OpenAI-compatible) has no list: each one names its own models.
 */
export function ModelPicker({
  id,
  provider,
  value,
  onChange,
  error,
}: {
  id: string;
  provider: KeyedProvider;
  value: ModelPick;
  onChange: (value: ModelPick) => void;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  const listed = MODEL_CATALOG[provider];
  const typing = value.choice === CUSTOM_MODEL;
  return (
    <div className="flex flex-col gap-4">
      {listed.length > 0 ? (
        <SelectField
          id={id}
          label={t('setup.models.model')}
          hint={t('setup.models.modelHint')}
          value={value.choice}
          onChange={(event) => onChange({ ...value, choice: event.target.value })}
          options={[
            ...listed.map((model) => ({
              value: model.id,
              label: `${model.id} (${t(`setup.models.tiers.${model.tier}`)}${
                model.recommended ? `, ${t('setup.models.recommended')}` : ''
              })`,
            })),
            { value: CUSTOM_MODEL, label: t('setup.models.customModel') },
          ]}
        />
      ) : null}
      {typing ? (
        <TextField
          id={`${id}-custom`}
          label={t('setup.models.customLabel')}
          hint={
            listed.length > 0 ? t('setup.models.customHint') : t('setup.models.customServerHint')
          }
          value={value.custom}
          dir="ltr"
          spellCheck={false}
          maxLength={200}
          onChange={(event) => onChange({ ...value, custom: event.target.value })}
          error={error}
        />
      ) : null}
    </div>
  );
}
