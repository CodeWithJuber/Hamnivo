/**
 * Automations (G21): rules a brand writes as "When … If … Then …". One rule reacts to one event,
 * checks its conditions against the facts known at that moment, and runs up to five actions.
 *
 * - Rules "on your website" (`visitor`) show a prompt next to the launcher (they replace W19's
 *   proactive triggers). The gateway checks what it knows (country, language, hours, who is
 *   online) and the loader checks the rest in the visitor's browser (page, referrer, visits,
 *   device, seconds on the page).
 * - Rules "in chats" (`conversation`) run in the worker from the outbox, once per conversation.
 *
 * This module is pure and shared: the gateway evaluates with it, the loader uses its text
 * matching, and Studio's "Try it" panel shows the same verdicts the worker reaches.
 */

export const AUTOMATION_KINDS = ['visitor', 'conversation'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export const AUTOMATION_EVENTS = [
  'page_view',
  'chat_started',
  'customer_waiting',
  'chat_closed',
  'offline_message',
] as const;
export type AutomationEventType = (typeof AUTOMATION_EVENTS)[number];

/** The kind of rule an event belongs to. */
export const kindOfEvent = (event: AutomationEventType): AutomationKind =>
  event === 'page_view' ? 'visitor' : 'conversation';

/** Seconds an event can wait, and its default: on a page, or for a reply. Others run at once. */
export const EVENT_SECONDS: Record<
  AutomationEventType,
  { min: number; max: number; default: number }
> = {
  page_view: { min: 0, max: 600, default: 10 },
  chat_started: { min: 0, max: 0, default: 0 },
  customer_waiting: { min: 30, max: 3600, default: 90 },
  chat_closed: { min: 0, max: 0, default: 0 },
  offline_message: { min: 0, max: 0, default: 0 },
};

export const TEXT_FIELDS = ['page_url', 'referrer'] as const;
export const NUMBER_FIELDS = ['visit_count'] as const;
export const CHOICE_FIELDS = ['country', 'device', 'language', 'owner', 'tag', 'team'] as const;
export const FLAG_FIELDS = ['hours_open', 'anyone_online', 'signed_in'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];
export type NumberField = (typeof NUMBER_FIELDS)[number];
export type ChoiceField = (typeof CHOICE_FIELDS)[number];
export type FlagField = (typeof FLAG_FIELDS)[number];
export type ConditionField = TextField | NumberField | ChoiceField | FlagField;

export const TEXT_OPS = ['contains', 'starts_with', 'is', 'not_contains'] as const;
export const NUMBER_OPS = ['at_least', 'at_most'] as const;
export const CHOICE_OPS = ['is', 'is_not'] as const;
export type TextOp = (typeof TEXT_OPS)[number];
export type NumberOp = (typeof NUMBER_OPS)[number];
export type ChoiceOp = (typeof CHOICE_OPS)[number];

export const DEVICES = ['desktop', 'mobile', 'tablet'] as const;
export type Device = (typeof DEVICES)[number];
/** Who has the chat: the AI, nobody yet (waiting for a person), or a person. */
export const OWNERS = ['ai', 'waiting', 'person'] as const;
export type ChatOwner = (typeof OWNERS)[number];

export type Condition =
  | { field: TextField; op: TextOp; value: string }
  | { field: NumberField; op: NumberOp; value: number }
  | { field: ChoiceField; op: ChoiceOp; value: string[] }
  | { field: FlagField; op: 'is'; value: boolean };

export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 5;

/** Which conditions each kind of rule can use. Signed-in, owner, tag and team exist only in chats. */
export const FIELDS_BY_KIND: Record<AutomationKind, readonly ConditionField[]> = {
  visitor: [
    'page_url',
    'referrer',
    'visit_count',
    'country',
    'device',
    'language',
    'hours_open',
    'anyone_online',
  ],
  conversation: [
    'page_url',
    'referrer',
    'visit_count',
    'country',
    'device',
    'language',
    'signed_in',
    'hours_open',
    'anyone_online',
    'owner',
    'tag',
    'team',
  ],
};

export const ACTION_TYPES = [
  'show_prompt',
  'send_message',
  'add_note',
  'add_tag',
  'set_priority',
  'assign_team',
  'make_ticket',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTIONS_BY_KIND: Record<AutomationKind, readonly ActionType[]> = {
  visitor: ['show_prompt'],
  conversation: [
    'send_message',
    'add_note',
    'add_tag',
    'set_priority',
    'assign_team',
    'make_ticket',
  ],
};

/** Actions a rule may hold only once (a second message or priority would contradict the first). */
export const SINGLE_ACTIONS: readonly ActionType[] = [
  'show_prompt',
  'send_message',
  'set_priority',
  'assign_team',
  'make_ticket',
];

/** Per-language words, English required (the same shape as the contracts' LocalizedText). */
export interface Words {
  en: string;
  ar?: string | undefined;
  hi?: string | undefined;
  ur?: string | undefined;
}

export type AutomationAction =
  | { type: 'show_prompt'; message: Words }
  | { type: 'send_message'; message: Words }
  | { type: 'add_note'; text: string }
  | { type: 'add_tag'; tag: string }
  | { type: 'set_priority'; priority: 'urgent' | 'high' | 'medium' | 'low' }
  | { type: 'assign_team'; teamId: string }
  | { type: 'make_ticket' };

export interface AutomationDefinition {
  event: { type: AutomationEventType; seconds: number };
  match: 'all' | 'any';
  conditions: Condition[];
  actions: AutomationAction[];
}

/**
 * What is known when a rule is checked. A fact left out is unknown, and a condition on an unknown
 * fact never matches, whatever its operator: a rule must not act on a guess.
 */
export interface AutomationFacts {
  page_url?: string | null;
  referrer?: string | null;
  visit_count?: number | null;
  country?: string | null;
  device?: Device | null;
  language?: string | null;
  signed_in?: boolean | null;
  hours_open?: boolean | null;
  anyone_online?: boolean | null;
  owner?: ChatOwner | null;
  tag?: readonly string[] | null;
  team?: string | null;
}

const lower = (text: string) => text.trim().toLowerCase();
/** `/pricing/` and `/pricing` are the same page. */
const trimSlash = (text: string) => (text.length > 1 ? text.replace(/\/+$/, '') : text);

/** Text matching, shared with the loader: case-insensitive, and "is" ignores a trailing slash. */
export function textMatches(op: TextOp, expected: string, subject: string): boolean {
  const want = lower(expected);
  const have = lower(subject);
  switch (op) {
    case 'contains':
      return have.includes(want);
    case 'not_contains':
      return !have.includes(want);
    case 'starts_with':
      return have.startsWith(want);
    case 'is':
      return trimSlash(have) === trimSlash(want);
  }
}

/** Whether one condition holds; null when its fact is unknown (which counts as not holding). */
export function checkCondition(condition: Condition, facts: AutomationFacts): boolean | null {
  switch (condition.field) {
    case 'page_url':
    case 'referrer': {
      const subject = facts[condition.field];
      if (subject === undefined || subject === null) return null;
      return textMatches(condition.op as TextOp, condition.value as string, subject);
    }
    case 'visit_count': {
      const count = facts.visit_count;
      if (count === undefined || count === null) return null;
      const n = condition.value as number;
      return condition.op === 'at_least' ? count >= n : count <= n;
    }
    case 'tag': {
      const tags = facts.tag;
      if (tags === undefined || tags === null) return null;
      const wanted = new Set((condition.value as string[]).map(lower));
      const any = tags.some((tag) => wanted.has(lower(tag)));
      return condition.op === 'is' ? any : !any;
    }
    case 'country':
    case 'device':
    case 'language':
    case 'owner':
    case 'team': {
      const subject = facts[condition.field];
      if (subject === undefined || subject === null) return null;
      // A language matches by its first part: "ar" covers "ar-EG".
      const have = condition.field === 'language' ? lower(subject).split('-')[0] : lower(subject);
      const listed = (condition.value as string[]).some((value) => lower(value) === have);
      return condition.op === 'is' ? listed : !listed;
    }
    case 'hours_open':
    case 'anyone_online':
    case 'signed_in': {
      const subject = facts[condition.field];
      if (subject === undefined || subject === null) return null;
      return subject === condition.value;
    }
  }
}

export interface Verdict {
  matched: boolean;
  /** One result per condition, in order: true, false, or null when its fact was unknown. */
  conditions: (boolean | null)[];
}

/** Checks a rule's conditions ("all" or "any"; a rule without conditions always matches). */
export function evaluate(
  definition: Pick<AutomationDefinition, 'match' | 'conditions'>,
  facts: AutomationFacts,
): Verdict {
  const conditions = definition.conditions.map((condition) => checkCondition(condition, facts));
  const matched =
    conditions.length === 0 ||
    (definition.match === 'all'
      ? conditions.every((result) => result === true)
      : conditions.some((result) => result === true));
  return { matched, conditions };
}

/** Whether a rule can only run while the AI does not have the chat (needed to send a message). */
export function excludesAi(
  definition: Pick<AutomationDefinition, 'match' | 'conditions'>,
): boolean {
  if (definition.match !== 'all') return false;
  return definition.conditions.some(
    (condition) =>
      condition.field === 'owner' &&
      (condition.op === 'is'
        ? condition.value.length > 0 && !condition.value.includes('ai')
        : condition.value.includes('ai')),
  );
}

export interface DefinitionProblem {
  /** Where, as a path into the definition (for field errors). */
  path: (string | number)[];
  code:
    | 'field_not_allowed'
    | 'action_not_allowed'
    | 'action_repeated'
    | 'prompt_required'
    | 'message_needs_people'
    | 'message_after_close'
    | 'seconds_out_of_range';
}

/**
 * What makes a rule unusable, beyond its shape: conditions and actions its kind cannot use, a
 * repeated single action, a website rule without its prompt, a message after the chat closed, and
 * a message that could interrupt the AI (G21 publishes such a rule only when "Who has the chat"
 * rules the AI out).
 */
export function definitionProblems(definition: AutomationDefinition): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const kind = kindOfEvent(definition.event.type);
  const range = EVENT_SECONDS[definition.event.type];
  if (definition.event.seconds < range.min || definition.event.seconds > range.max) {
    problems.push({ path: ['event', 'seconds'], code: 'seconds_out_of_range' });
  }
  definition.conditions.forEach((condition, index) => {
    if (!FIELDS_BY_KIND[kind].includes(condition.field)) {
      problems.push({ path: ['conditions', index, 'field'], code: 'field_not_allowed' });
    }
  });
  const seen = new Set<ActionType>();
  definition.actions.forEach((action, index) => {
    if (!ACTIONS_BY_KIND[kind].includes(action.type)) {
      problems.push({ path: ['actions', index, 'type'], code: 'action_not_allowed' });
    } else if (SINGLE_ACTIONS.includes(action.type) && seen.has(action.type)) {
      problems.push({ path: ['actions', index, 'type'], code: 'action_repeated' });
    }
    seen.add(action.type);
    if (action.type === 'send_message') {
      if (definition.event.type === 'chat_closed') {
        problems.push({ path: ['actions', index, 'type'], code: 'message_after_close' });
      } else if (!excludesAi(definition)) {
        problems.push({ path: ['actions', index, 'type'], code: 'message_needs_people' });
      }
    }
  });
  if (kind === 'visitor' && !seen.has('show_prompt')) {
    problems.push({ path: ['actions'], code: 'prompt_required' });
  }
  return problems;
}

/** The facts the loader knows in the browser; the gateway knows the others before it answers. */
export const BROWSER_FIELDS: readonly ConditionField[] = [
  'page_url',
  'referrer',
  'visit_count',
  'device',
];

/** A condition the loader checks, compactly: [field, op, value]. */
export type BrowserCondition =
  | ['page_url' | 'referrer', TextOp, string]
  | ['visit_count', NumberOp, number]
  | ['device', ChoiceOp, string[]];

/**
 * Splits a website rule for the loader: the gateway decides the conditions it knows (country,
 * language, hours, who is online) now, and hands the browser's conditions on. Null when the rule
 * cannot match for this visitor whatever their browser says.
 *
 * - "all": every known condition must hold now; the browser checks every one of its own.
 * - "any": one known condition holding is enough (nothing left for the browser); otherwise the
 *   browser needs one of its own to hold.
 */
export function splitForBrowser(
  definition: Pick<AutomationDefinition, 'match' | 'conditions'>,
  facts: AutomationFacts,
): { any: boolean; when: BrowserCondition[] } | null {
  const browser: BrowserCondition[] = [];
  const known: (boolean | null)[] = [];
  for (const condition of definition.conditions) {
    if (BROWSER_FIELDS.includes(condition.field)) {
      browser.push([condition.field, condition.op, condition.value] as BrowserCondition);
    } else {
      known.push(checkCondition(condition, facts));
    }
  }
  if (definition.match === 'all') {
    return known.every((result) => result === true) ? { any: false, when: browser } : null;
  }
  if (definition.conditions.length === 0 || known.some((result) => result === true)) {
    return { any: false, when: [] };
  }
  return browser.length > 0 ? { any: true, when: browser } : null;
}

/** The loader's check of the conditions the gateway handed on. */
export function browserMatches(
  rule: { any: boolean; when: BrowserCondition[] },
  facts: { page_url: string; referrer: string; visit_count: number; device: Device },
): boolean {
  if (rule.when.length === 0) return true;
  const results = rule.when.map(([field, op, value]) =>
    field === 'visit_count'
      ? op === 'at_least'
        ? facts.visit_count >= (value as number)
        : facts.visit_count <= (value as number)
      : field === 'device'
        ? (value as string[]).includes(facts.device) === (op === 'is')
        : textMatches(op as TextOp, value as string, facts[field]),
  );
  return rule.any ? results.some(Boolean) : results.every(Boolean);
}

/** The device class from the width of the visitor's window, as the loader sees it. */
export const deviceOf = (width: number): Device =>
  width < 640 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';

/** At most this many messages from automations reach one conversation in a day. */
export const MAX_AUTOMATED_MESSAGES_PER_DAY = 5;
