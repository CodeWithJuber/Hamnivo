/**
 * Automations (G21): the working copy Studio edits for one rule, what is sent for it, what would
 * be refused before it is sent, the sentence that sums a rule up, the facts the "Try it" panel
 * checks it against, and the requests that read and change rules.
 *
 * The verdicts come from `@hamnivo/domain/automations`, the same code the gateway and the worker
 * run, so "Try it" and the inline warnings say what the rule will really do. The shape checks
 * here mirror the contract (`packages/contracts/src/automations.ts`); the gateway checks all of it
 * again and is the one that decides.
 */
import type * as C from '@hamnivo/contracts';
import {
  ACTIONS_BY_KIND,
  type ActionType,
  AUTOMATION_EVENTS,
  type AutomationDefinition,
  type AutomationEventType,
  type AutomationFacts,
  type AutomationKind,
  CHOICE_FIELDS,
  CHOICE_OPS,
  type ConditionField,
  type DefinitionProblem,
  definitionProblems,
  EVENT_SECONDS,
  FIELDS_BY_KIND,
  FLAG_FIELDS,
  kindOfEvent,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  NUMBER_FIELDS,
  NUMBER_OPS,
  SINGLE_ACTIONS,
  TEXT_FIELDS,
  TEXT_OPS,
  type Words,
} from '@hamnivo/domain/automations';
import i18next, { type TFunction } from 'i18next';
import { api } from './api';
import { CHAT_LANGUAGES, type ChatTexts, textsOf } from './appearance';
import { formatRelative } from './format';
import { useStudioMutation, useStudioQuery } from './queries';
import type { ChatLanguage } from './setup-data';

export type Automation = C.Automation;
export type AutomationList = C.AutomationList;
export type AutomationOptions = C.AutomationOptions;
export type AutomationVersion = C.AutomationVersion;
export type AutomationRun = C.AutomationRun;
export type { ActionType, AutomationEventType, AutomationKind, ConditionField };
export { MAX_ACTIONS, MAX_CONDITIONS };

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const NAME_MAX = 80;
export const TEXT_VALUE_MAX = 200;
export const NOTE_MAX = 2000;
/** Words next to the launcher are short; a message in the chat may say more. */
export const MESSAGE_MAX: Record<'show_prompt' | 'send_message', number> = {
  show_prompt: 160,
  send_message: 1000,
};
export const VISITS_MIN = 1;
export const VISITS_MAX = 1000;

// ── Fields and what they take ─────────────────────────────────────────────────────────────────

export type FieldType = 'text' | 'number' | 'choice' | 'flag';

export function fieldType(field: ConditionField): FieldType {
  if ((TEXT_FIELDS as readonly string[]).includes(field)) return 'text';
  if ((NUMBER_FIELDS as readonly string[]).includes(field)) return 'number';
  if ((CHOICE_FIELDS as readonly string[]).includes(field)) return 'choice';
  return 'flag';
}

/** The operators a field can use, in the order the list offers them. */
export function opsOf(field: ConditionField): readonly string[] {
  switch (fieldType(field)) {
    case 'text':
      return TEXT_OPS;
    case 'number':
      return NUMBER_OPS;
    case 'choice':
      return CHOICE_OPS;
    case 'flag':
      return ['is'];
  }
}

/** The events a rule of this kind can react to (a rule never changes kind). */
export const eventsOf = (kind: AutomationKind): AutomationEventType[] =>
  AUTOMATION_EVENTS.filter((event) => kindOfEvent(event) === kind);

/** Whether an event waits a while, and so asks for seconds. */
export const hasSeconds = (event: AutomationEventType) => EVENT_SECONDS[event].max > 0;

export const isFlagField = (field: ConditionField) =>
  (FLAG_FIELDS as readonly string[]).includes(field);

// ── The working copy ──────────────────────────────────────────────────────────────────────────

export interface ConditionDraft {
  /** Stable while the editor is open; the controls of the row are named by it. */
  key: string;
  field: ConditionField;
  op: string;
  /** Text fields: the words; visits: the number as typed. */
  text: string;
  /** Choice fields: the values chosen. */
  choices: string[];
  /** Yes/no fields. */
  flag: boolean;
}

export interface ActionDraft {
  key: string;
  type: ActionType;
  /** A prompt or a message, per language (kept while another type is chosen). */
  message: ChatTexts;
  /** A private note. */
  text: string;
  tag: string;
  teamId: string;
  priority: Priority;
}

export interface AutomationDraft {
  name: string;
  event: AutomationEventType;
  /** As typed. */
  seconds: string;
  match: 'all' | 'any';
  conditions: ConditionDraft[];
  actions: ActionDraft[];
}

/** The first `<prefix><n>` that is not taken. */
export function freeKey(prefix: string, taken: readonly string[]): string {
  for (let n = taken.length; ; n += 1) {
    const key = `${prefix}${n}`;
    if (!taken.includes(key)) return key;
  }
}

export function newCondition(field: ConditionField, key: string): ConditionDraft {
  return {
    key,
    field,
    op: opsOf(field)[0] ?? 'is',
    text: field === 'visit_count' ? '2' : '',
    choices: field === 'owner' ? ['ai'] : [],
    flag: true,
  };
}

/** A row asking about another fact: the operator and value start again for its kind of value. */
export function withField(condition: ConditionDraft, field: ConditionField): ConditionDraft {
  if (fieldType(field) === fieldType(condition.field) && field !== 'visit_count') {
    return { ...newCondition(field, condition.key), op: condition.op, text: condition.text };
  }
  return newCondition(field, condition.key);
}

export function newAction(type: ActionType, key: string): ActionDraft {
  return {
    key,
    type,
    message: textsOf(null),
    text: '',
    tag: '',
    teamId: '',
    priority: 'high',
  };
}

/** The action a new row starts as: the first of its kind's that the rule may still add. */
export function nextActionType(kind: AutomationKind, actions: readonly ActionDraft[]): ActionType {
  const used = new Set(actions.map((action) => action.type));
  return (
    ACTIONS_BY_KIND[kind].find((type) => !(SINGLE_ACTIONS.includes(type) && used.has(type))) ??
    ACTIONS_BY_KIND[kind][0] ??
    'show_prompt'
  );
}

/** The fact a new condition asks about first. */
export function nextField(
  kind: AutomationKind,
  conditions: readonly ConditionDraft[],
): ConditionField {
  const used = new Set(conditions.map((condition) => condition.field));
  const all = FIELDS_BY_KIND[kind];
  return all.find((field) => !used.has(field)) ?? all[0] ?? 'page_url';
}

const conditionDraftOf = (condition: C.AutomationCondition, key: string): ConditionDraft => {
  const base = newCondition(condition.field, key);
  switch (fieldType(condition.field)) {
    case 'text':
      return { ...base, op: condition.op, text: String(condition.value) };
    case 'number':
      return { ...base, op: condition.op, text: String(condition.value) };
    case 'choice':
      return { ...base, op: condition.op, choices: [...(condition.value as string[])] };
    case 'flag':
      return { ...base, op: 'is', flag: condition.value === true };
  }
};

const actionDraftOf = (action: C.AutomationAction, key: string): ActionDraft => {
  const base = newAction(action.type, key);
  switch (action.type) {
    case 'show_prompt':
    case 'send_message':
      return { ...base, message: textsOf(action.message) };
    case 'add_note':
      return { ...base, text: action.text };
    case 'add_tag':
      return { ...base, tag: action.tag };
    case 'set_priority':
      return { ...base, priority: action.priority };
    case 'assign_team':
      return { ...base, teamId: action.teamId };
    case 'make_ticket':
      return base;
  }
};

export const draftOf = (name: string, definition: C.AutomationDefinition): AutomationDraft => ({
  name,
  event: definition.event.type,
  seconds: String(definition.event.seconds),
  match: definition.match,
  conditions: definition.conditions.map((condition, index) =>
    conditionDraftOf(condition, `c${index}`),
  ),
  actions: definition.actions.map((action, index) => actionDraftOf(action, `a${index}`)),
});

/** English plus the languages written. */
export function wordsOf(texts: ChatTexts): Words {
  const out: Partial<Record<ChatLanguage, string>> = {};
  for (const lang of CHAT_LANGUAGES) {
    const text = texts[lang].trim();
    if (text) out[lang] = text;
  }
  return { ...out, en: texts.en.trim() } as Words;
}

const wholeOf = (text: string): number => (/^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN);

function conditionOf(condition: ConditionDraft): C.AutomationCondition {
  switch (fieldType(condition.field)) {
    case 'text':
      return {
        field: condition.field,
        op: condition.op,
        value: condition.text.trim(),
      } as C.AutomationCondition;
    case 'number':
      return {
        field: 'visit_count',
        op: condition.op as 'at_least' | 'at_most',
        value: wholeOf(condition.text),
      };
    case 'choice':
      return {
        field: condition.field,
        op: condition.op,
        value: [...condition.choices],
      } as C.AutomationCondition;
    case 'flag':
      return { field: condition.field, op: 'is', value: condition.flag } as C.AutomationCondition;
  }
}

function actionOf(action: ActionDraft): C.AutomationAction {
  switch (action.type) {
    case 'show_prompt':
    case 'send_message':
      return { type: action.type, message: wordsOf(action.message) } as C.AutomationAction;
    case 'add_note':
      return { type: 'add_note', text: action.text.trim() };
    case 'add_tag':
      return { type: 'add_tag', tag: action.tag.trim() };
    case 'set_priority':
      return { type: 'set_priority', priority: action.priority };
    case 'assign_team':
      return { type: 'assign_team', teamId: action.teamId };
    case 'make_ticket':
      return { type: 'make_ticket' };
  }
}

/** The definition a draft describes (numbers still being typed read as not a number). */
export const definitionOf = (draft: AutomationDraft): C.AutomationDefinition => ({
  event: { type: draft.event, seconds: hasSeconds(draft.event) ? wholeOf(draft.seconds) : 0 },
  match: draft.match,
  conditions: draft.conditions.map(conditionOf),
  actions: draft.actions.map(actionOf),
});

/** What is saved for a draft. */
export const bodyOf = (draft: AutomationDraft) => ({
  name: draft.name.trim(),
  definition: definitionOf(draft),
});

export const isDirty = (draft: AutomationDraft, saved: AutomationDraft): boolean =>
  JSON.stringify(bodyOf(draft)) !== JSON.stringify(bodyOf(saved));

/** The same definition, as the domain module reads it. */
export const domainOf = (definition: C.AutomationDefinition): AutomationDefinition =>
  definition as AutomationDefinition;

// ── What would be refused ─────────────────────────────────────────────────────────────────────

export type DraftProblem =
  | { kind: 'name' }
  | { kind: 'seconds'; min: number; max: number }
  | { kind: 'conditionValue'; key: string; index: number }
  | { kind: 'conditionNumber'; key: string; index: number }
  | { kind: 'conditionLong'; key: string; index: number }
  | { kind: 'messageEnglish'; key: string; index: number }
  | { kind: 'messageLong'; key: string; index: number; max: number }
  | { kind: 'note'; key: string; index: number }
  | { kind: 'tag'; key: string; index: number }
  | { kind: 'team'; key: string; index: number }
  | { kind: 'noActions' };

/** What the gateway's schema would refuse, in the order the page shows it. */
export function problemsOf(draft: AutomationDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (!draft.name.trim()) out.push({ kind: 'name' });
  if (hasSeconds(draft.event)) {
    const range = EVENT_SECONDS[draft.event];
    const seconds = wholeOf(draft.seconds);
    if (!(seconds >= range.min && seconds <= range.max)) {
      out.push({ kind: 'seconds', min: range.min, max: range.max });
    }
  }
  draft.conditions.forEach((condition, index) => {
    const at = { key: condition.key, index };
    switch (fieldType(condition.field)) {
      case 'text':
        if (!condition.text.trim()) out.push({ kind: 'conditionValue', ...at });
        else if (condition.text.trim().length > TEXT_VALUE_MAX)
          out.push({ kind: 'conditionLong', ...at });
        break;
      case 'number': {
        const n = wholeOf(condition.text);
        if (!(n >= VISITS_MIN && n <= VISITS_MAX)) out.push({ kind: 'conditionNumber', ...at });
        break;
      }
      case 'choice':
        if (condition.choices.length === 0) out.push({ kind: 'conditionValue', ...at });
        break;
      case 'flag':
        break;
    }
  });
  draft.actions.forEach((action, index) => {
    const at = { key: action.key, index };
    switch (action.type) {
      case 'show_prompt':
      case 'send_message': {
        const max = MESSAGE_MAX[action.type];
        if (!action.message.en.trim()) out.push({ kind: 'messageEnglish', ...at });
        else if (CHAT_LANGUAGES.some((lang) => action.message[lang].trim().length > max))
          out.push({ kind: 'messageLong', ...at, max });
        break;
      }
      case 'add_note':
        if (!action.text.trim()) out.push({ kind: 'note', ...at });
        break;
      case 'add_tag':
        if (!action.tag.trim()) out.push({ kind: 'tag', ...at });
        break;
      case 'assign_team':
        if (!action.teamId) out.push({ kind: 'team', ...at });
        break;
      default:
        break;
    }
  });
  if (draft.actions.length === 0) out.push({ kind: 'noActions' });
  return out;
}

/**
 * What would stop the rule from being published as written (the domain's own check, the one the
 * gateway runs): a fact or action its kind cannot use, a repeated action, a message that could
 * interrupt the AI. A draft with these can still be saved.
 */
export function warningsOf(draft: AutomationDraft): DefinitionProblem[] {
  return definitionProblems(domainOf(definitionOf(draft))).filter(
    // A time out of range is already a problem of the seconds box.
    (problem) => problem.code !== 'seconds_out_of_range',
  );
}

// ── Where each control is ─────────────────────────────────────────────────────────────────────

export const automationIds = {
  name: 'automation-name',
  event: 'automation-event',
  seconds: 'automation-seconds',
  match: 'automation-match',
  conditions: 'automation-conditions',
  addCondition: 'automation-add-condition',
  actions: 'automation-actions',
  addAction: 'automation-add-action',
  conditionField: (key: string) => `condition-${key}-field`,
  conditionOp: (key: string) => `condition-${key}-op`,
  conditionValue: (key: string) => `condition-${key}-value`,
  actionType: (key: string) => `action-${key}-type`,
  actionMessage: (key: string) => `action-${key}-message`,
  actionText: (key: string) => `action-${key}-text`,
  actionTag: (key: string) => `action-${key}-tag`,
  actionTeam: (key: string) => `action-${key}-team`,
  actionPriority: (key: string) => `action-${key}-priority`,
} as const;

const ids = automationIds;

/** The control a problem is about (the English box for missing words). */
export function problemControl(problem: DraftProblem): string {
  switch (problem.kind) {
    case 'name':
      return ids.name;
    case 'seconds':
      return ids.seconds;
    case 'conditionValue':
    case 'conditionNumber':
    case 'conditionLong':
      return ids.conditionValue(problem.key);
    case 'messageEnglish':
    case 'messageLong':
      return `${ids.actionMessage(problem.key)}-en`;
    case 'note':
      return ids.actionText(problem.key);
    case 'tag':
      return ids.actionTag(problem.key);
    case 'team':
      return ids.actionTeam(problem.key);
    case 'noActions':
      return ids.addAction;
  }
}

/** The control a domain problem is about, from its path into the definition. */
export function warningControl(problem: DefinitionProblem, draft: AutomationDraft): string {
  return controlOfPath(['definition', ...problem.path].join('.'), draft);
}

const isIndex = (part: string | undefined): part is string =>
  part !== undefined && /^\d+$/.test(part);

/**
 * The control a gateway refusal is about, from the path it names (`definition.conditions.2.value`,
 * `definition.actions.0.message.en`, `name`). A path Studio does not know points at the name.
 */
export function controlOfPath(path: string, draft: AutomationDraft): string {
  const parts = path.split('.');
  if (parts[0] === 'name') return ids.name;
  if (parts[0] !== 'definition') return ids.name;
  const [, area, index, part, sub] = parts;
  if (area === 'event') return part === undefined && index === 'seconds' ? ids.seconds : ids.event;
  if (area === 'match') return `${ids.match}-${draft.match}`;
  if (area === 'conditions') {
    const condition = isIndex(index) ? draft.conditions[Number(index)] : undefined;
    if (!condition) return ids.conditions;
    if (part === 'field') return ids.conditionField(condition.key);
    if (part === 'op') return ids.conditionOp(condition.key);
    return ids.conditionValue(condition.key);
  }
  if (area === 'actions') {
    const action = isIndex(index) ? draft.actions[Number(index)] : undefined;
    if (!action) return ids.addAction;
    switch (part) {
      case 'message':
        return `${ids.actionMessage(action.key)}-${
          (CHAT_LANGUAGES as readonly string[]).includes(sub ?? '') ? sub : 'en'
        }`;
      case 'text':
        return ids.actionText(action.key);
      case 'tag':
        return ids.actionTag(action.key);
      case 'teamId':
        return ids.actionTeam(action.key);
      case 'priority':
        return ids.actionPriority(action.key);
      default:
        return ids.actionType(action.key);
    }
  }
  return ids.name;
}

// ── In words ──────────────────────────────────────────────────────────────────────────────────

/** The interface language, for names, lists and units through Intl. */
const languageOf = (_t?: TFunction) => i18next.resolvedLanguage ?? i18next.language ?? 'en';

/** "90 s", "10 min", in the interface language. */
export function durationText(seconds: number, locale: string): string {
  const minutes = seconds >= 60 && seconds % 60 === 0;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: minutes ? 'minute' : 'second',
    unitDisplay: 'short',
  }).format(minutes ? seconds / 60 : seconds);
}

function listText(items: string[], type: 'conjunction' | 'disjunction', locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type }).format(items);
  } catch {
    return items.join(', ');
  }
}

function displayName(type: 'region' | 'language', code: string, locale: string): string {
  try {
    return new Intl.DisplayNames(locale, { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface Names {
  /** A support team's name by its id. */
  team?: (id: string) => string | undefined;
}

/** One chosen value of a choice field, as people read it. */
export function choiceText(
  field: ConditionField,
  value: string,
  t: TFunction,
  names: Names = {},
): string {
  const locale = languageOf(t);
  switch (field) {
    case 'country':
      return displayName('region', value.toUpperCase(), locale);
    case 'language':
      return displayName('language', value, locale);
    case 'device':
      return t(`automations.devices.${value as 'desktop'}`, { defaultValue: value });
    case 'owner':
      return t(`automations.owners.${value as 'ai'}`, { defaultValue: value });
    case 'team':
      return names.team?.(value) ?? value;
    default:
      return value;
  }
}

/** One condition in words: "the page address contains /pricing". */
export function conditionText(
  condition: C.AutomationCondition,
  t: TFunction,
  names: Names = {},
): string {
  const locale = languageOf(t);
  const field = t(`automations.summary.fields.${condition.field}`);
  switch (fieldType(condition.field)) {
    case 'flag':
      return t(
        `automations.summary.flags.${condition.field as 'hours_open'}.${condition.value ? 'yes' : 'no'}`,
      );
    case 'choice': {
      const word = (v: string) =>
        condition.field === 'owner'
          ? t(`automations.summary.owners.${v as 'ai'}`, { defaultValue: v })
          : condition.field === 'device'
            ? t(`automations.summary.devices.${v as 'mobile'}`, { defaultValue: v })
            : choiceText(condition.field, v, t, names);
      const value = listText((condition.value as string[]).map(word), 'disjunction', locale);
      return t(`automations.summary.ops.${condition.op as 'is'}`, { field, value });
    }
    default:
      return t(`automations.summary.ops.${condition.op as 'contains'}`, {
        field,
        value: String(condition.value),
      });
  }
}

/** One action in words: "show a prompt", "add the tag vip". */
export function actionText(action: C.AutomationAction, t: TFunction, names: Names = {}): string {
  switch (action.type) {
    case 'add_tag':
      return t('automations.summary.actions.add_tag', { tag: action.tag });
    case 'set_priority':
      return t('automations.summary.actions.set_priority', {
        priority: t(`automations.summary.priorities.${action.priority}`),
      });
    case 'assign_team':
      return t('automations.summary.actions.assign_team', {
        team: names.team?.(action.teamId) ?? t('automations.summary.aTeam'),
      });
    default:
      return t(`automations.summary.actions.${action.type}`);
  }
}

/** "When a chat starts" / "When a visitor has been on a page for 30 s". */
export function eventText(event: C.AutomationDefinition['event'], t: TFunction): string {
  const locale = languageOf(t);
  if (event.type === 'page_view' && event.seconds === 0)
    return t('automations.summary.events.page_open');
  return t(`automations.summary.events.${event.type}`, {
    duration: durationText(Number.isFinite(event.seconds) ? event.seconds : 0, locale),
  });
}

/**
 * A rule in one sentence, for the list: "When a visitor has been on a page for 30 s, if the page
 * address contains /pricing → show a prompt".
 */
export function summaryOf(
  definition: C.AutomationDefinition,
  t: TFunction,
  names: Names = {},
): string {
  const locale = languageOf(t);
  const event = eventText(definition.event, t);
  const actions = listText(
    definition.actions.map((action) => actionText(action, t, names)),
    'conjunction',
    locale,
  );
  if (definition.conditions.length === 0) {
    return t('automations.summary.always', { event, actions });
  }
  const conditions = listText(
    definition.conditions.map((condition) => conditionText(condition, t, names)),
    definition.match === 'all' ? 'conjunction' : 'disjunction',
    locale,
  );
  return t('automations.summary.sentence', { event, conditions, actions });
}

export type StatusKey = 'off' | 'draft' | 'changes' | 'published';

/** Where a rule stands: off, never published, published with later changes, or published. */
export function statusOf(
  automation: Pick<Automation, 'enabled' | 'published' | 'unpublishedChanges'>,
): {
  key: StatusKey;
  version: number | null;
} {
  const version = automation.published?.version ?? null;
  if (!automation.enabled) return { key: 'off', version };
  if (!automation.published) return { key: 'draft', version };
  if (automation.unpublishedChanges) return { key: 'changes', version };
  return { key: 'published', version };
}

/** "Ran 34 times this week · last run 2 hours ago" for chat rules. */
export function activityText(automation: Automation, t: TFunction, now = Date.now()): string {
  if (automation.kind === 'visitor') return t('automations.list.inBrowser');
  const { runsThisWeek, lastRunAt } = automation.stats;
  if (runsThisWeek === 0 && !lastRunAt) return t('automations.list.neverRan');
  const ran =
    runsThisWeek === 1
      ? t('automations.list.ranOnce')
      : t('automations.list.ranTimes', { n: runsThisWeek });
  return lastRunAt
    ? t('automations.list.ranLast', { ran, when: formatRelative(lastRunAt, now) })
    : ran;
}

// ── Try it ────────────────────────────────────────────────────────────────────────────────────

/** Yes, no, or not known. */
export type Tri = '' | 'yes' | 'no';

/** The sample facts as typed in the "Try it" panel; an empty one is unknown. */
export interface SampleFacts {
  page_url: string;
  referrer: string;
  visit_count: string;
  country: string;
  device: string;
  language: string;
  signed_in: Tri;
  hours_open: Tri;
  anyone_online: Tri;
  owner: string;
  /** Comma separated. */
  tag: string;
  team: string;
}

export const sampleFactsFor = (language: string): SampleFacts => ({
  page_url: 'https://example.com/',
  referrer: '',
  visit_count: '1',
  country: '',
  device: 'desktop',
  language,
  signed_in: '',
  hours_open: 'yes',
  anyone_online: 'yes',
  owner: 'waiting',
  tag: '',
  team: '',
});

const tri = (value: Tri): boolean | null => (value === '' ? null : value === 'yes');
const textFact = (value: string): string | null => (value.trim() ? value.trim() : null);

/** What the sample says, as the evaluator reads facts: anything left empty is unknown. */
export function factsOf(sample: SampleFacts): AutomationFacts {
  const visits = wholeOf(sample.visit_count);
  const tags = sample.tag
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    page_url: textFact(sample.page_url),
    referrer: textFact(sample.referrer),
    visit_count: Number.isFinite(visits) ? visits : null,
    country: textFact(sample.country)?.toUpperCase() ?? null,
    device: (textFact(sample.device) as AutomationFacts['device']) ?? null,
    language: textFact(sample.language),
    signed_in: tri(sample.signed_in),
    hours_open: tri(sample.hours_open),
    anyone_online: tri(sample.anyone_online),
    owner: (textFact(sample.owner) as AutomationFacts['owner']) ?? null,
    tag: tags.length > 0 ? tags : null,
    team: textFact(sample.team),
  };
}

/** The language a message is previewed in: the visitor's, when the chat speaks it. */
export const previewLanguageOf = (sample: SampleFacts): ChatLanguage => {
  const lang = sample.language.trim().toLowerCase().split('-')[0] ?? '';
  return (CHAT_LANGUAGES as readonly string[]).includes(lang) ? (lang as ChatLanguage) : 'en';
};

/** The words customers read in one language (English when that language is not written). */
export const wordsIn = (
  texts: ChatTexts,
  lang: ChatLanguage,
): { text: string; lang: ChatLanguage } =>
  texts[lang].trim() ? { text: texts[lang].trim(), lang } : { text: texts.en.trim(), lang: 'en' };

// ── Reading and saving ────────────────────────────────────────────────────────────────────────

export const automationKeys = {
  list: (brandId: string) => ['automations', 'brand', brandId],
  options: (brandId: string) => ['automations', 'brand', brandId, 'options'],
  one: (id: string) => ['automations', 'one', id],
  versions: (id: string) => ['automations', 'one', id, 'versions'],
  runs: (id: string) => ['automations', 'one', id, 'runs'],
  all: ['automations'],
} as const;

const brandPath = (brandId: string, rest = '') =>
  `/v1/admin/brands/${encodeURIComponent(brandId)}/automations${rest}`;
const onePath = (id: string, rest = '') => `/v1/admin/automations/${encodeURIComponent(id)}${rest}`;

export const useAutomations = (brandId: string, enabled = true) =>
  useStudioQuery<AutomationList>(automationKeys.list(brandId), brandPath(brandId), { enabled });

export const useAutomationOptions = (brandId: string | undefined) =>
  useStudioQuery<AutomationOptions>(
    automationKeys.options(brandId ?? 'none'),
    brandPath(brandId ?? 'none', '/options'),
    { enabled: Boolean(brandId) },
  );

export const useAutomation = (id: string) =>
  useStudioQuery<Automation>(automationKeys.one(id), onePath(id));

export const useAutomationVersions = (id: string) =>
  useStudioQuery<C.AutomationVersionList>(automationKeys.versions(id), onePath(id, '/versions'));

export const useAutomationRuns = (id: string, enabled: boolean) =>
  useStudioQuery<C.AutomationRunList>(automationKeys.runs(id), onePath(id, '/runs?limit=20'), {
    enabled,
  });

export interface CreateBody {
  name: string;
  definition: C.AutomationDefinition;
  publish?: boolean;
}

export const useCreateAutomation = (brandId: string) =>
  useStudioMutation(
    (body: CreateBody, tenant) =>
      api<Automation>(brandPath(brandId), {
        method: 'POST',
        body: { publish: false, ...body },
        tenant,
      }),
    [automationKeys.list(brandId)],
  );

export const useSavePromptLimits = (brandId: string) =>
  useStudioMutation(
    (body: { maxPerDay: number; dismissHours: number }, tenant) =>
      api<AutomationList>(brandPath(brandId, '/prompt-limits'), { method: 'PUT', body, tenant }),
    [automationKeys.list(brandId)],
  );

/** Changes to one rule; every list and the rule itself load again afterwards. */
export const useAutomationChange = <TVars>(
  id: string,
  request: (vars: TVars) => { path: string; method: 'PUT' | 'POST' | 'DELETE'; body?: unknown },
) =>
  useStudioMutation(
    (vars: TVars, tenant) => {
      const { path, method, body } = request(vars);
      return api<Automation>(onePath(id, path), { method, body, tenant });
    },
    [automationKeys.all],
  );

export const saveRequest = (body: {
  name: string;
  definition: C.AutomationDefinition;
  revision: number;
}) => ({
  path: '',
  method: 'PUT' as const,
  body,
});
export const publishRequest = (revision: number) => ({
  path: '/publish',
  method: 'POST' as const,
  body: { revision },
});
export const enabledRequest = (enabled: boolean) => ({
  path: '/enabled',
  method: 'PUT' as const,
  body: { enabled },
});
export const restoreRequest = ({ version, revision }: { version: number; revision: number }) => ({
  path: `/versions/${version}/restore`,
  method: 'POST' as const,
  body: { revision },
});
export const deleteRequest = () => ({ path: '', method: 'DELETE' as const });
