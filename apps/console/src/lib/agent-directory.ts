/**
 * The agent directory (HNV-11-01): what each agent is for, where it answers, which model and
 * version customers get, and finding one by typing or filtering. Only what the gateway does is
 * said: a brand's conversations are answered by its default agent's published version alone
 * (AgentsService.activeFor), so another agent answers no one until it becomes the default.
 */
import type { Agent, AgentDetail } from './types';

/** A model choice without its connection: provider and model ID only. */
export type ModelRef = Pick<
  NonNullable<AgentDetail['published']>['config']['model'],
  'provider' | 'modelId'
>;

/** Where an agent's replies go, as the gateway decides it. */
export type AnswerState = 'customers' | 'assist' | 'notDefault' | 'notLive' | 'archived';

export function answerState(
  agent: Pick<Agent, 'status' | 'isDefault' | 'publishedVersion'>,
  publishedMode: 'answer' | 'assist' | undefined,
): AnswerState {
  if (agent.status === 'archived') return 'archived';
  if (agent.publishedVersion === null) return 'notLive';
  if (!agent.isDefault) return 'notDefault';
  return publishedMode === 'assist' ? 'assist' : 'customers';
}

/** One agent as the directory shows it. Never the model connection or any key. */
export interface DirectoryRow {
  agent: Agent;
  brandName: string;
  displayName: string | undefined;
  purpose: string | undefined;
  /** The model customers get: the published version's. */
  liveModel: ModelRef | undefined;
  /** The draft's model, only when it differs from the live one. */
  draftModel: ModelRef | undefined;
  answer: AnswerState;
  /** The agent's details are still loading. */
  loading: boolean;
}

const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  a?.provider === b?.provider && a?.modelId === b?.modelId;

export function directoryRow(
  agent: Agent,
  detail: AgentDetail | undefined,
  brandName: string,
): DirectoryRow {
  const published = detail?.published?.config;
  const draft = detail?.draft?.config;
  const shown = draft ?? published;
  const liveModel = published
    ? { provider: published.model.provider, modelId: published.model.modelId }
    : undefined;
  const draftModelChoice = draft
    ? { provider: draft.model.provider, modelId: draft.model.modelId }
    : undefined;
  return {
    agent,
    brandName,
    displayName: shown?.displayName,
    purpose: shown?.purpose?.trim() || undefined,
    liveModel,
    draftModel:
      draftModelChoice && !sameModel(draftModelChoice, liveModel) ? draftModelChoice : undefined,
    answer: answerState(agent, published?.mode),
    loading: detail === undefined,
  };
}

/** `answering`: it replies to customers or suggests replies to staff now. */
export type StateFilter = 'all' | 'answering' | 'idle';

export interface DirectoryFilters {
  query: string;
  /** A brand ID, or '' for every brand. */
  brandId: string;
  state: StateFilter;
}

export const NO_FILTERS: DirectoryFilters = { query: '', brandId: '', state: 'all' };

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/**
 * Whether a row is shown: every typed word appears in its name, display name, purpose, brand or
 * model, and it passes the brand and state filters.
 */
export function rowMatches(row: DirectoryRow, filters: DirectoryFilters): boolean {
  if (filters.brandId && row.agent.brandId !== filters.brandId) return false;
  const answering = row.answer === 'customers' || row.answer === 'assist';
  if (filters.state === 'answering' && !answering) return false;
  if (filters.state === 'idle' && answering) return false;
  const words = normalize(filters.query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize(
    [
      row.agent.name,
      row.displayName ?? '',
      row.purpose ?? '',
      row.brandName,
      row.liveModel?.modelId ?? '',
      row.draftModel?.modelId ?? '',
    ].join(' '),
  );
  return words.every((word) => haystack.includes(word));
}

export const isFiltered = (filters: DirectoryFilters) =>
  filters.query.trim() !== '' || filters.brandId !== '' || filters.state !== 'all';
