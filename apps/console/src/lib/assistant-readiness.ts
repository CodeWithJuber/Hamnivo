/**
 * "Make the AI assistant work": what a brand still needs before its AI can act on a customer's
 * WHMCS account, in the order a person does it. Each step is worked out from lists Studio already
 * reads; a list this person cannot read makes its step `unknown`, never `done`. Whether the
 * website really signs customers in is not recorded anywhere, so that step is always `check`.
 */
import type { BuiltinTool, ToolDefinition } from './actions';
import type { IdentityKey } from './identity';
import type { ModelSetupStatus } from './setup';
import type { ModelConnection } from './types';

export const READINESS_STEPS = [
  'aikey',
  'model',
  'signin',
  'whmcs',
  'actions',
  'demo',
  'website',
] as const;
export type ReadinessStepId = (typeof READINESS_STEPS)[number];

/**
 * `done`: nothing to do. `todo`: not set up yet. `attention`: set up, but not working.
 * `unknown`: this person cannot read what would tell. `check`: Studio cannot tell; look yourself.
 */
export type ReadinessState = 'done' | 'todo' | 'attention' | 'unknown' | 'check';

/** Why the AI key step is not done: the last test's result, or that no key was tested yet. */
export type AiKeyReason =
  | 'untested'
  | 'wrong_key'
  | 'no_credit'
  | 'model_not_found'
  | 'network'
  | 'blocked'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown';

/** One step, with which wording to use when a state has more than one. */
export type ReadinessStep =
  | { id: 'aikey'; state: ReadinessState; reason?: AiKeyReason }
  | { id: 'model'; state: ReadinessState; reason?: 'noAgent' | 'notLive' | 'mock' }
  | { id: 'signin'; state: ReadinessState }
  | { id: 'whmcs'; state: ReadinessState; reason?: 'failing' | 'disabled' }
  | { id: 'actions'; state: ReadinessState; reason?: 'connectFirst' }
  | { id: 'demo'; state: ReadinessState }
  | { id: 'website'; state: ReadinessState };

/** The brand's agent as the checklist reads it: its published version, or its draft. */
export interface ReadinessAgent {
  id: string;
  published: boolean;
  /** The model provider of the version that answers (published, else draft). */
  provider: string | undefined;
  /** Tool ids the agent may call (published version, else draft). */
  grants: readonly string[] | undefined;
}

/** One WHMCS, Shopify or WooCommerce connection of the brand. */
export interface ReadinessConnector {
  kind: string;
  status: 'active' | 'disabled';
  lastError: string | null;
}

/** What each list says, or `undefined` when this person cannot read it or it has not loaded. */
export interface ReadinessFacts {
  serverKey: boolean | undefined;
  modelConnections: readonly Pick<ModelConnection, 'id' | 'status'>[] | undefined;
  modelTests: ModelSetupStatus['tests'] | undefined;
  /** `null`: the brand has no agent. */
  agent: ReadinessAgent | null | undefined;
  identityKeys: readonly Pick<IdentityKey, 'status'>[] | undefined;
  connectors: readonly ReadinessConnector[] | undefined;
  tools:
    | readonly Pick<ToolDefinition, 'id' | 'source' | 'builtin' | 'resourceType' | 'status'>[]
    | undefined;
  builtins: readonly Pick<BuiltinTool, 'key' | 'demo'>[] | undefined;
}

function aiKey(f: ReadinessFacts): ReadinessStep {
  if (f.serverKey === true) return { id: 'aikey', state: 'done' };
  if (!f.modelConnections || !f.modelTests) return { id: 'aikey', state: 'unknown' };
  const active = f.modelConnections.filter((c) => c.status === 'active');
  if (active.length === 0) return { id: 'aikey', state: 'todo' };
  const tests = active
    .map((c) => f.modelTests?.find((test) => test.connectionId === c.id))
    .filter((test) => test !== undefined);
  if (tests.some((test) => test.ok)) return { id: 'aikey', state: 'done' };
  // A key nobody tested yet is not known to work.
  const failed = tests.find((test) => !test.ok);
  if (!failed) return { id: 'aikey', state: 'todo', reason: 'untested' };
  return {
    id: 'aikey',
    state: 'attention',
    reason: failed.kind === 'ok' ? 'unknown' : failed.kind,
  };
}

function model(f: ReadinessFacts): ReadinessStep {
  if (f.agent === undefined) return { id: 'model', state: 'unknown' };
  if (f.agent === null) return { id: 'model', state: 'todo', reason: 'noAgent' };
  if (f.agent.provider === 'mock') return { id: 'model', state: 'attention', reason: 'mock' };
  if (!f.agent.published) return { id: 'model', state: 'todo', reason: 'notLive' };
  return { id: 'model', state: 'done' };
}

function signin(f: ReadinessFacts): ReadinessStep {
  if (!f.identityKeys) return { id: 'signin', state: 'unknown' };
  return {
    id: 'signin',
    state: f.identityKeys.some((key) => key.status === 'active') ? 'done' : 'todo',
  };
}

function whmcs(f: ReadinessFacts): ReadinessStep {
  if (!f.connectors) return { id: 'whmcs', state: 'unknown' };
  const own = f.connectors.filter((c) => c.kind === 'whmcs');
  if (own.length === 0) return { id: 'whmcs', state: 'todo' };
  if (own.some((c) => c.status === 'active' && !c.lastError)) return { id: 'whmcs', state: 'done' };
  return {
    id: 'whmcs',
    state: 'attention',
    reason: own.some((c) => c.status === 'active') ? 'failing' : 'disabled',
  };
}

/** WHMCS actions the brand offers: tools made by a WHMCS connection, switched on. */
const whmcsTools = (f: ReadinessFacts) =>
  (f.tools ?? []).filter(
    (tool) =>
      tool.source === 'native' && tool.resourceType === 'whmcs' && tool.status === 'enabled',
  );

function actions(f: ReadinessFacts): ReadinessStep {
  if (!f.tools || f.agent === undefined) return { id: 'actions', state: 'unknown' };
  const offered = whmcsTools(f);
  if (offered.length === 0) return { id: 'actions', state: 'todo', reason: 'connectFirst' };
  if (!f.agent?.grants) return { id: 'actions', state: f.agent ? 'unknown' : 'todo' };
  const granted = new Set(f.agent.grants);
  return {
    id: 'actions',
    state: offered.some((tool) => granted.has(tool.id)) ? 'done' : 'todo',
  };
}

function demo(f: ReadinessFacts): ReadinessStep {
  if (!f.tools || !f.builtins || f.agent === undefined) return { id: 'demo', state: 'unknown' };
  if (!f.agent) return { id: 'demo', state: 'done' };
  if (!f.agent.grants) return { id: 'demo', state: 'unknown' };
  const demoKeys = new Set(f.builtins.filter((b) => b.demo).map((b) => b.key));
  const granted = new Set(f.agent.grants);
  const uses = (f.tools ?? []).some(
    (tool) =>
      tool.source === 'builtin' &&
      tool.builtin &&
      demoKeys.has(tool.builtin) &&
      granted.has(tool.id),
  );
  return { id: 'demo', state: uses ? 'attention' : 'done' };
}

/** Every step, in the order to do them. */
export function readinessSteps(facts: ReadinessFacts): ReadinessStep[] {
  return [
    aiKey(facts),
    model(facts),
    signin(facts),
    whmcs(facts),
    actions(facts),
    demo(facts),
    { id: 'website', state: 'check' },
  ];
}

/** Whether anything is left to do: a step that is not set up or not working. */
export const needsWork = (steps: readonly ReadinessStep[]) =>
  steps.some((step) => step.state === 'todo' || step.state === 'attention');
