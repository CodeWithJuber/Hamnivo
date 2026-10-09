import { ACTIONS_BY_KIND, DEVICES, FIELDS_BY_KIND, OWNERS } from '@hamnivo/domain/automations';
import { Button } from '@hamnivo/ui/components/button';
import { FieldDescription, FieldError, FieldLegend, FieldSet } from '@hamnivo/ui/components/field';
import { Input } from '@hamnivo/ui/components/input';
import { CheckIcon, PlusIcon, Trash2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../../components/Fields';
import {
  type ActionDraft,
  type ActionType,
  type AutomationKind,
  type AutomationOptions,
  type ConditionDraft,
  type ConditionField,
  choiceText,
  fieldType,
  automationIds as ids,
  MESSAGE_MAX,
  NOTE_MAX,
  opsOf,
  PRIORITIES,
  type Priority,
  TEXT_VALUE_MAX,
  withField,
} from '../../lib/automations';
import { LocalizedFields } from '../BrandChatSettings';

/** A warning next to a control: the rule can be saved, but not published as it is. */
export function Warning({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle p-2 text-sm text-text"
      data-testid="automation-warning"
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

interface Choice {
  value: string;
  label: string;
}

/**
 * Several values for one condition. With a fixed list (devices, who has the chat, the brand's
 * tags and teams) each value is a toggle; otherwise (countries, languages) values are typed and
 * added one by one. Either way the first control carries `id`, so errors can point at it.
 */
function ChipsField({
  id,
  legend,
  hint,
  error,
  value,
  choices,
  normalize,
  label,
  addLabel,
  onChange,
}: {
  id: string;
  legend: string;
  hint?: string | undefined;
  error?: string | undefined;
  value: string[];
  /** A fixed list to choose from; typed values otherwise. */
  choices?: Choice[] | undefined;
  /** Typed values: the value to add, or null when what was typed is not one. */
  normalize?: (typed: string) => string | null;
  label: (value: string) => string;
  addLabel: string;
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  const add = () => {
    const next = normalize ? normalize(typed) : typed.trim();
    if (!next) return;
    if (!value.includes(next)) onChange([...value, next]);
    setTyped('');
  };
  return (
    <FieldSet className="gap-2" data-invalid={error ? true : undefined}>
      <FieldLegend variant="label" className="mb-0 text-sm">
        {legend}
      </FieldLegend>
      {hint ? (
        <FieldDescription id={`${id}-hint`} className="mt-0">
          {hint}
        </FieldDescription>
      ) : null}
      {choices ? (
        <ul className="flex flex-wrap gap-2">
          {choices.map((choice, index) => {
            const on = value.includes(choice.value);
            return (
              <li key={choice.value}>
                <Button
                  id={index === 0 ? id : `${id}-${index}`}
                  type="button"
                  size="sm"
                  variant={on ? 'default' : 'secondary'}
                  aria-pressed={on}
                  aria-invalid={error && index === 0 ? true : undefined}
                  aria-describedby={index === 0 && describedBy ? describedBy : undefined}
                  onClick={() =>
                    onChange(
                      on ? value.filter((v) => v !== choice.value) : [...value, choice.value],
                    )
                  }
                >
                  {on ? <CheckIcon aria-hidden="true" /> : null}
                  <bdi>{choice.label}</bdi>
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Input
              id={id}
              className="w-40"
              dir="ltr"
              value={typed}
              aria-label={addLabel}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy || undefined}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <Button type="button" variant="secondary" size="sm" onClick={add}>
              <PlusIcon aria-hidden="true" />
              {t('automations.editor.ifStep.addValue')}
            </Button>
          </div>
          {value.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label={legend}>
              {value.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-1 rounded-full border border-border bg-surface-sunken ps-3 text-sm text-text"
                >
                  <bdi>{label(item)}</bdi>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('automations.editor.ifStep.removeValue', { value: label(item) })}
                    onClick={() => onChange(value.filter((v) => v !== item))}
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </FieldSet>
  );
}

const COUNTRY = /^[A-Za-z]{2}$/;
const LANGUAGE = /^[A-Za-z]{2,3}$/;

export function ConditionRow({
  kind,
  condition,
  index,
  options,
  errors,
  warning,
  onChange,
  onRemove,
}: {
  kind: AutomationKind;
  condition: ConditionDraft;
  index: number;
  options: AutomationOptions | undefined;
  errors: Record<string, string>;
  warning: string | null;
  onChange: (condition: ConditionDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const number = index + 1;
  const type = fieldType(condition.field);
  const fieldId = ids.conditionField(condition.key);
  const opId = ids.conditionOp(condition.key);
  const valueId = ids.conditionValue(condition.key);
  const allowed = FIELDS_BY_KIND[kind];
  const fields: ConditionField[] = allowed.includes(condition.field)
    ? [...allowed]
    : [condition.field, ...allowed];
  const names = { team: (id: string) => options?.teams.find((team) => team.id === id)?.name };
  const label = (value: string) => choiceText(condition.field, value, t, names);
  const valueLegend = t('automations.editor.ifStep.value');

  let value: React.ReactNode;
  if (type === 'text' || type === 'number') {
    value = (
      <TextField
        id={valueId}
        label={valueLegend}
        value={condition.text}
        dir={type === 'text' ? 'ltr' : undefined}
        inputMode={type === 'number' ? 'numeric' : undefined}
        maxLength={type === 'text' ? TEXT_VALUE_MAX + 1 : 5}
        error={errors[valueId]}
        onChange={(event) => onChange({ ...condition, text: event.target.value })}
      />
    );
  } else if (type === 'flag') {
    value = (
      <SelectField
        id={valueId}
        label={valueLegend}
        value={condition.flag ? 'yes' : 'no'}
        error={errors[valueId]}
        onChange={(event) => onChange({ ...condition, flag: event.target.value === 'yes' })}
        options={[
          { value: 'yes', label: t('automations.editor.ifStep.yes') },
          { value: 'no', label: t('automations.editor.ifStep.no') },
        ]}
      />
    );
  } else {
    let choices: Choice[] | undefined;
    let hint: string | undefined;
    let normalize: ((typed: string) => string | null) | undefined;
    switch (condition.field) {
      case 'device':
        choices = DEVICES.map((device) => ({ value: device, label: label(device) }));
        break;
      case 'owner':
        choices = OWNERS.map((owner) => ({ value: owner, label: label(owner) }));
        break;
      case 'team':
        choices = (options?.teams ?? []).map((team) => ({ value: team.id, label: team.name }));
        // A team chosen before and gone since stays visible, so it can be taken off.
        for (const chosen of condition.choices) {
          if (!choices.some((choice) => choice.value === chosen)) {
            choices.push({ value: chosen, label: chosen });
          }
        }
        if (choices.length === 0) hint = t('automations.editor.ifStep.noTeams');
        break;
      case 'tag':
        if (options?.tags) {
          choices = [...new Set([...options.tags, ...condition.choices])].map((tag) => ({
            value: tag,
            label: tag,
          }));
          if (choices.length === 0) hint = t('automations.editor.ifStep.noTags');
        } else {
          hint = t('automations.editor.ifStep.tagHint');
          normalize = (typed) => typed.trim().toLowerCase() || null;
        }
        break;
      case 'country':
        hint = t('automations.editor.ifStep.countryHint');
        normalize = (typed) => (COUNTRY.test(typed.trim()) ? typed.trim().toUpperCase() : null);
        break;
      case 'language':
        hint = t('automations.editor.ifStep.languageHint');
        normalize = (typed) => (LANGUAGE.test(typed.trim()) ? typed.trim().toLowerCase() : null);
        break;
      default:
        break;
    }
    value = (
      <ChipsField
        id={valueId}
        legend={valueLegend}
        hint={hint}
        error={errors[valueId]}
        value={condition.choices}
        choices={choices}
        {...(normalize ? { normalize } : {})}
        label={label}
        addLabel={t('automations.editor.ifStep.addValueLabel', { number })}
        onChange={(choices) => onChange({ ...condition, choices })}
      />
    );
  }

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
      data-testid="condition-row"
      data-field={condition.field}
    >
      <legend className="px-1 text-sm font-semibold text-text">
        {t('automations.editor.ifStep.condition', { number })}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id={fieldId}
          label={t('automations.editor.ifStep.field')}
          value={condition.field}
          error={errors[fieldId]}
          onChange={(event) => onChange(withField(condition, event.target.value as ConditionField))}
          options={fields.map((field) => ({
            value: field,
            label: t(`automations.editor.fields.${field}`),
          }))}
        />
        {type === 'flag' ? null : (
          <SelectField
            id={opId}
            label={t('automations.editor.ifStep.op')}
            value={condition.op}
            error={errors[opId]}
            onChange={(event) => onChange({ ...condition, op: event.target.value })}
            options={opsOf(condition.field).map((op) => ({
              value: op,
              label: t(`automations.editor.ops.${op as 'is'}`),
            }))}
          />
        )}
      </div>
      {value}
      {warning ? <Warning>{warning}</Warning> : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        aria-label={t('automations.editor.ifStep.remove', { number })}
        onClick={onRemove}
      >
        <Trash2Icon aria-hidden="true" />
        {t('automations.editor.ifStep.removeShort')}
      </Button>
    </fieldset>
  );
}

export function ActionRow({
  kind,
  action,
  index,
  options,
  errors,
  warning,
  onChange,
  onRemove,
}: {
  kind: AutomationKind;
  action: ActionDraft;
  index: number;
  options: AutomationOptions | undefined;
  errors: Record<string, string>;
  warning: string | null;
  onChange: (action: ActionDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const number = index + 1;
  const typeId = ids.actionType(action.key);
  const allowed = ACTIONS_BY_KIND[kind];
  const types: ActionType[] = allowed.includes(action.type)
    ? [...allowed]
    : [action.type, ...allowed];
  let body: React.ReactNode = null;
  switch (action.type) {
    case 'show_prompt':
    case 'send_message': {
      const max = MESSAGE_MAX[action.type];
      const messageId = ids.actionMessage(action.key);
      body = (
        <LocalizedFields
          id={messageId}
          legend={
            action.type === 'show_prompt'
              ? t('automations.editor.thenStep.prompt')
              : t('automations.editor.thenStep.message')
          }
          hint={t('automations.editor.thenStep.messageHint', { max })}
          value={action.message}
          maxLength={max}
          multiline={action.type === 'send_message'}
          error={errors[`${messageId}-en`]}
          onChange={(message) => onChange({ ...action, message })}
        />
      );
      break;
    }
    case 'add_note': {
      const textId = ids.actionText(action.key);
      body = (
        <TextField
          id={textId}
          label={t('automations.editor.thenStep.note')}
          value={action.text}
          maxLength={NOTE_MAX}
          error={errors[textId]}
          onChange={(event) => onChange({ ...action, text: event.target.value })}
        />
      );
      break;
    }
    case 'add_tag': {
      const tagId = ids.actionTag(action.key);
      const tags = options?.tags;
      const unknown = tags && action.tag.trim() && !tags.includes(action.tag.trim().toLowerCase());
      body = tags ? (
        <div className="flex flex-col gap-2">
          <SelectField
            id={tagId}
            label={t('automations.editor.thenStep.tag')}
            value={action.tag}
            placeholder={t('automations.editor.thenStep.tagPlaceholder')}
            error={errors[tagId]}
            onChange={(event) => onChange({ ...action, tag: event.target.value })}
            options={[...new Set([...tags, ...(action.tag ? [action.tag] : [])])].map((tag) => ({
              value: tag,
              label: tag,
            }))}
          />
          {unknown ? (
            <Warning>{t('automations.editor.thenStep.tagUnknown', { tag: action.tag })}</Warning>
          ) : null}
        </div>
      ) : (
        <TextField
          id={tagId}
          label={t('automations.editor.thenStep.tagFree')}
          hint={t('automations.editor.thenStep.tagFreeHint')}
          value={action.tag}
          maxLength={255}
          error={errors[tagId]}
          onChange={(event) => onChange({ ...action, tag: event.target.value })}
        />
      );
      break;
    }
    case 'assign_team': {
      const teamId = ids.actionTeam(action.key);
      const teams = options?.teams ?? [];
      body = (
        <SelectField
          id={teamId}
          label={t('automations.editor.thenStep.team')}
          value={action.teamId}
          placeholder={t('automations.editor.thenStep.teamPlaceholder')}
          hint={teams.length === 0 ? t('automations.editor.ifStep.noTeams') : undefined}
          error={errors[teamId]}
          onChange={(event) => onChange({ ...action, teamId: event.target.value })}
          options={[
            ...teams.map((team) => ({ value: team.id, label: team.name })),
            ...(action.teamId && !teams.some((team) => team.id === action.teamId)
              ? [{ value: action.teamId, label: action.teamId }]
              : []),
          ]}
        />
      );
      break;
    }
    case 'set_priority': {
      const priorityId = ids.actionPriority(action.key);
      body = (
        <SelectField
          id={priorityId}
          label={t('automations.editor.thenStep.priority')}
          value={action.priority}
          error={errors[priorityId]}
          onChange={(event) => onChange({ ...action, priority: event.target.value as Priority })}
          options={PRIORITIES.map((priority) => ({
            value: priority,
            label: t(`automations.priorities.${priority}`),
          }))}
        />
      );
      break;
    }
    case 'make_ticket':
      break;
  }
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
      data-testid="action-row"
      data-type={action.type}
    >
      <legend className="px-1 text-sm font-semibold text-text">
        {t('automations.editor.thenStep.action', { number })}
      </legend>
      <SelectField
        id={typeId}
        label={t('automations.editor.thenStep.type')}
        value={action.type}
        error={errors[typeId]}
        onChange={(event) => onChange({ ...action, type: event.target.value as ActionType })}
        options={types.map((type) => ({
          value: type,
          label: t(`automations.editor.actions.${type}`),
        }))}
      />
      {body}
      {warning ? <Warning>{warning}</Warning> : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        aria-label={t('automations.editor.thenStep.remove', { number })}
        onClick={onRemove}
      >
        <Trash2Icon aria-hidden="true" />
        {t('automations.editor.thenStep.removeShort')}
      </Button>
    </fieldset>
  );
}
