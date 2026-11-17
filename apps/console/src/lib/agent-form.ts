import type { TFunction } from 'i18next';
import type { AgentConfig, ModelChoice, ModelProviderKind } from './types';

/** Interface languages offered as checkboxes; any other BCP 47 tag can be typed. */
export const LISTED_LANGUAGES = ['en', 'ar', 'hi', 'ur'] as const;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export const PROVIDERS: ModelProviderKind[] = [
  'anthropic',
  'openai',
  'google',
  'openai-compatible',
  'mock',
];

export interface ModelRow {
  provider: ModelProviderKind;
  modelId: string;
  /** '' means the key the server was started with. */
  connectionId: string;
}

/** The editor's working copy. Numbers stay text while typing; they are checked on save. */
export interface AgentForm {
  displayName: string;
  purpose: string;
  instructions: string;
  tone: AgentConfig['tone'];
  languages: string[];
  otherLanguages: string;
  mode: AgentConfig['mode'];
  model: ModelRow;
  fallbacks: ModelRow[];
  maxOutputTokens: string;
  timeoutSeconds: string;
  historyMessages: string;
  maxSteps: string;
  knowledgeSourceIds: string[];
  /** Customer memory (G19): only for customers who agree, within these limits. */
  memoryEnabled: boolean;
  memoryMaxItems: string;
  memoryMaxChars: string;
  /** Tools the agent may call (G07); `autopilot` off means it always asks for approval. */
  toolGrants: { toolId: string; autopilot: boolean }[];
  /** Action budgets (G15, X03). */
  maxCallsPerRun: string;
  maxAutopilotPerConversation: string;
  /** What the assistant may do within Hamnivo while answering. */
  actions: AgentConfig['actions'];
}

const toRow = (choice: ModelChoice): ModelRow => ({
  provider: choice.provider,
  modelId: choice.modelId,
  connectionId: choice.connectionId ?? '',
});

const isListed = (tag: string) => (LISTED_LANGUAGES as readonly string[]).includes(tag);

export function toForm(config: AgentConfig): AgentForm {
  return {
    displayName: config.displayName,
    purpose: config.purpose,
    instructions: config.instructions,
    tone: config.tone,
    languages: config.languages.filter(isListed),
    otherLanguages: config.languages.filter((tag) => !isListed(tag)).join(', '),
    mode: config.mode,
    model: toRow(config.model),
    fallbacks: config.fallbackModels.map(toRow),
    maxOutputTokens: String(config.limits.maxOutputTokens),
    timeoutSeconds: String(config.limits.timeoutMs / 1000),
    historyMessages: String(config.limits.historyMessages),
    maxSteps: String(config.limits.maxSteps),
    knowledgeSourceIds: [...config.knowledgeSourceIds],
    memoryEnabled: config.memory?.enabled ?? false,
    memoryMaxItems: String(config.memory?.maxItems ?? 8),
    memoryMaxChars: String(config.memory?.maxChars ?? 1200),
    toolGrants: (config.tools?.grants ?? []).map((g) => ({
      toolId: g.toolId,
      autopilot: g.autopilot,
    })),
    maxCallsPerRun: String(config.tools?.maxCallsPerRun ?? 4),
    maxAutopilotPerConversation: String(config.tools?.maxAutopilotPerConversation ?? 5),
    actions: {
      handoff: config.actions?.handoff ?? false,
      choices: config.actions?.choices ?? false,
      contact: config.actions?.contact ?? false,
      search: config.actions?.search ?? false,
    },
  };
}

export const FIELD_IDS = {
  displayName: 'agent-displayName',
  purpose: 'agent-purpose',
  instructions: 'agent-instructions',
  languages: 'agent-lang-en',
  otherLanguages: 'agent-otherLanguages',
  modelId: 'agent-model-modelId',
  fallbackModelId: (index: number) => `agent-fallback-${index}-modelId`,
  maxOutputTokens: 'agent-maxOutputTokens',
  timeoutSeconds: 'agent-timeoutSeconds',
  historyMessages: 'agent-historyMessages',
  maxSteps: 'agent-maxSteps',
  knowledge: 'agent-knowledge',
  memoryEnabled: 'agent-memory-enabled',
  memoryMaxItems: 'agent-memory-maxItems',
  memoryMaxChars: 'agent-memory-maxChars',
  tools: 'agent-tools',
  maxCallsPerRun: 'agent-tools-maxCallsPerRun',
  maxAutopilotPerConversation: 'agent-tools-maxAutopilot',
  action: (key: keyof AgentConfig['actions']) => `agent-action-${key}`,
} as const;

function choice(row: ModelRow): ModelChoice {
  const connection = row.provider !== 'mock' && row.connectionId ? row.connectionId : undefined;
  return {
    provider: row.provider,
    modelId: row.modelId.trim(),
    ...(connection ? { connectionId: connection } : {}),
  };
}

function whole(value: string, min: number, max: number): number | null {
  const number = Number(value.trim());
  return value.trim() !== '' && Number.isInteger(number) && number >= min && number <= max
    ? number
    : null;
}

export type FieldErrors = Record<string, string>;

/**
 * Checks the form against the AgentConfig contract (the gateway checks again) and builds the
 * configuration to save. Errors are keyed by the id of the field to focus.
 */
export function toConfig(
  form: AgentForm,
  t: TFunction,
): { config: AgentConfig; errors: null } | { config: null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const displayName = form.displayName.trim();
  if (!displayName || displayName.length > 60) {
    errors[FIELD_IDS.displayName] = t('editor.errors.displayName');
  }
  if (form.purpose.trim().length > 2000) errors[FIELD_IDS.purpose] = t('editor.errors.purpose');
  if (form.instructions.length > 20_000) {
    errors[FIELD_IDS.instructions] = t('editor.errors.instructions');
  }

  const others = form.otherLanguages
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const badTag = others.find((tag) => !LANGUAGE_TAG.test(tag));
  if (badTag) errors[FIELD_IDS.otherLanguages] = t('editor.errors.languageTag', { tag: badTag });
  const languages = [...new Set([...form.languages, ...others])];
  if (languages.length < 1 || languages.length > 20) {
    errors[FIELD_IDS.languages] = t('editor.errors.languages');
  }

  const rowOk = (row: ModelRow) => row.modelId.trim().length >= 1 && row.modelId.length <= 200;
  if (!rowOk(form.model)) errors[FIELD_IDS.modelId] = t('editor.errors.modelId');
  form.fallbacks.forEach((row, index) => {
    if (!rowOk(row)) errors[FIELD_IDS.fallbackModelId(index)] = t('editor.errors.modelId');
  });

  const limit = (id: string, value: string, min: number, max: number) => {
    const number = whole(value, min, max);
    if (number === null) errors[id] = t('editor.errors.number', { min, max });
    return number ?? min;
  };
  const maxOutputTokens = limit(FIELD_IDS.maxOutputTokens, form.maxOutputTokens, 16, 8192);
  const seconds = Number(form.timeoutSeconds.trim());
  const timeoutMs = Math.round(seconds * 1000);
  if (
    !form.timeoutSeconds.trim() ||
    !Number.isFinite(seconds) ||
    timeoutMs < 1000 ||
    timeoutMs > 120_000
  ) {
    errors[FIELD_IDS.timeoutSeconds] = t('editor.errors.number', { min: 1, max: 120 });
  }
  const historyMessages = limit(FIELD_IDS.historyMessages, form.historyMessages, 1, 100);
  const maxSteps = limit(FIELD_IDS.maxSteps, form.maxSteps, 1, 10);
  if (form.knowledgeSourceIds.length > 20)
    errors[FIELD_IDS.knowledge] = t('editor.errors.knowledge');
  const memoryMaxItems = limit(FIELD_IDS.memoryMaxItems, form.memoryMaxItems, 1, 20);
  const memoryMaxChars = limit(FIELD_IDS.memoryMaxChars, form.memoryMaxChars, 100, 4000);
  if (form.toolGrants.length > 30) errors[FIELD_IDS.tools] = t('tools.grants.tooMany');
  const maxCallsPerRun = limit(FIELD_IDS.maxCallsPerRun, form.maxCallsPerRun, 1, 10);
  const maxAutopilotPerConversation = limit(
    FIELD_IDS.maxAutopilotPerConversation,
    form.maxAutopilotPerConversation,
    0,
    50,
  );

  if (Object.keys(errors).length > 0) return { config: null, errors };
  return {
    errors: null,
    config: {
      displayName,
      purpose: form.purpose.trim(),
      instructions: form.instructions,
      tone: form.tone,
      languages,
      mode: form.mode,
      model: choice(form.model),
      fallbackModels: form.fallbacks.map(choice),
      limits: { maxOutputTokens, timeoutMs, historyMessages, maxSteps },
      knowledgeSourceIds: [...form.knowledgeSourceIds],
      memory: {
        enabled: form.memoryEnabled,
        maxItems: memoryMaxItems,
        maxChars: memoryMaxChars,
      },
      tools: {
        grants: form.toolGrants.map((g) => ({ toolId: g.toolId, autopilot: g.autopilot })),
        maxCallsPerRun,
        maxAutopilotPerConversation,
      },
      // In the gateway's key order, so an unchanged configuration compares equal.
      actions: {
        handoff: form.actions.handoff,
        choices: form.actions.choices,
        contact: form.actions.contact,
        search: form.actions.search,
      },
    },
  };
}

/** Two configurations as the gateway returns them (same key order) are equal as JSON. */
export const sameConfig = (a: AgentConfig, b: AgentConfig) =>
  JSON.stringify(a) === JSON.stringify(b);

export type SectionKey =
  | 'displayName'
  | 'purpose'
  | 'instructions'
  | 'tone'
  | 'languages'
  | 'mode'
  | 'model'
  | 'fallback'
  | 'limits'
  | 'knowledge'
  | 'memory'
  | 'tools'
  | 'actions';

/** Which parts differ between two working copies, for the conflict message. */
export function differences(mine: AgentForm, theirs: AgentForm): SectionKey[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const result: SectionKey[] = [];
  if (!same(mine.displayName, theirs.displayName)) result.push('displayName');
  if (!same(mine.purpose, theirs.purpose)) result.push('purpose');
  if (!same(mine.instructions, theirs.instructions)) result.push('instructions');
  if (!same(mine.tone, theirs.tone)) result.push('tone');
  if (!same([mine.languages, mine.otherLanguages], [theirs.languages, theirs.otherLanguages])) {
    result.push('languages');
  }
  if (!same(mine.mode, theirs.mode)) result.push('mode');
  if (!same(mine.model, theirs.model)) result.push('model');
  if (!same(mine.fallbacks, theirs.fallbacks)) result.push('fallback');
  if (
    !same(
      [mine.maxOutputTokens, mine.timeoutSeconds, mine.historyMessages, mine.maxSteps],
      [theirs.maxOutputTokens, theirs.timeoutSeconds, theirs.historyMessages, theirs.maxSteps],
    )
  ) {
    result.push('limits');
  }
  if (!same([...mine.knowledgeSourceIds].sort(), [...theirs.knowledgeSourceIds].sort())) {
    result.push('knowledge');
  }
  if (
    !same(
      [mine.memoryEnabled, mine.memoryMaxItems, mine.memoryMaxChars],
      [theirs.memoryEnabled, theirs.memoryMaxItems, theirs.memoryMaxChars],
    )
  ) {
    result.push('memory');
  }
  if (
    !same(
      [mine.toolGrants, mine.maxCallsPerRun, mine.maxAutopilotPerConversation],
      [theirs.toolGrants, theirs.maxCallsPerRun, theirs.maxAutopilotPerConversation],
    )
  ) {
    result.push('tools');
  }
  if (!same(mine.actions, theirs.actions)) result.push('actions');
  return result;
}

/** Maps a gateway validation path (config.model, …) to the field that shows it. */
export function fieldForPath(path: string): string | undefined {
  const key = path.replace(/^config\./, '').split('.')[0];
  switch (key) {
    case 'displayName':
      return FIELD_IDS.displayName;
    case 'purpose':
      return FIELD_IDS.purpose;
    case 'instructions':
      return FIELD_IDS.instructions;
    case 'languages':
      return FIELD_IDS.otherLanguages;
    case 'model':
      return FIELD_IDS.modelId;
    case 'fallbackModels':
      return FIELD_IDS.fallbackModelId(0);
    case 'limits':
      return FIELD_IDS.maxOutputTokens;
    case 'knowledgeSourceIds':
      return FIELD_IDS.knowledge;
    case 'memory':
      return FIELD_IDS.memoryMaxItems;
    case 'tools':
      return FIELD_IDS.tools;
    default:
      return undefined;
  }
}
